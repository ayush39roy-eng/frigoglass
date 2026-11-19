"""P53-T02 -- one week line, open horizon, delivery by year (ADR 0063, R53-1..R53-9,
I57-I63).

Clock weeks exercised: 47 / 52 / 53 / 104 / 105 / 364 / 365 (2026 W47, the two
sides of each year boundary, and the ISO-53 year 2032), N = 1 / 5 / 10.
Fixtures: the minimal two-step workflow (`PDD-A` design 2 wk -> `PDD-F` lab
3 wk) and the 46-project seed.
"""

from __future__ import annotations

import ast
import dataclasses
import time
from pathlib import Path

import pytest

import domain_constants as dc
import scheduling
from scheduling import (
    ProjectInput,
    ScheduleInput,
    check_i57_run_weeks,
    check_i58_horizon,
    check_i59_delivery,
    check_i60_cp_sat_tail,
    check_i63_tail_flags,
    delivery_by_year,
    delivery_rows,
    forecast_delivery,
    run_cp_sat,
    run_greedy_sgs,
    tail_flags,
    validate_invariants,
)
from scheduling._selftest_common import load_seed_schedule_input
from scheduling.delivery import (
    LEFT_OUT_REASONS,
    DeliveryRow,
    far_finish,
    leader_tails,
    left_out_reason,
    outcome_left_out_reason,
)
from scheduling.weeks import (
    DEFAULT_HORIZON_YEARS,
    abs_week,
    check_horizon_years,
    commercialized_within_year,
    counts_toward_year,
    cp_sat_window,
    horizon_for,
    plan_until_presets,
    plan_year_end_week,
    plan_year_start_week,
    queue_tier,
    week_of_year,
    weeks_left_in_year,
    year_end,
    year_of,
    year_relative_to_abs,
    year_start,
    year_windows,
)
from tests.scheduling._fixtures import (
    CHAMBER_GR1,
    CHAMBER_GR2,
    ENGINEER_A,
    LEAD_TIMES,
    TEMPLATE,
    base_project,
)

CLOCK_WEEKS = (47, 52, 53, 104, 105, 364, 365)
CP_KW: dict[str, float] = {"deterministic_time": 3.0, "earliness_deterministic_time": 1.0}


def _si(*projects: ProjectInput, **kw: object) -> ScheduleInput:
    base: dict[str, object] = dict(
        projects=projects,
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1, CHAMBER_GR2),
        workflow_steps=TEMPLATE,
        lead_times=LEAD_TIMES,
        current_week=47,
    )
    base.update(kw)
    return ScheduleInput(**base)  # type: ignore[arg-type]


def _chain(n: int, **kw: object) -> tuple[ProjectInput, ...]:
    """`n` P1 projects on one leader: 2 design weeks each, serial."""

    return tuple(
        base_project(project_id=f"p{i:03d}", name=f"P{i}", **kw)
        for i in range(n)
    )


def _cp(si: ScheduleInput) -> tuple[scheduling.ScheduleOutput, scheduling.CpSatSolveInfo]:
    return run_cp_sat(si, deterministic_time=3.0, earliness_deterministic_time=1.0)


def _by(out: scheduling.ScheduleOutput) -> dict[str, scheduling.ProjectScheduleOutcome]:
    return {o.project_id: o for o in out.project_outcomes}


# =====================================================================================
# R53-1 / I57: the week helpers
# =====================================================================================

# (week, year_of, week_of_year): the shared table the frontend mirror is tested on.
WEEK_TABLE = (
    (1, 2026, 1),
    (47, 2026, 47),
    (52, 2026, 52),
    (53, 2027, 1),
    (104, 2027, 52),
    (105, 2028, 1),
    (364, 2032, 52),
    (365, 2033, 1),
)


@pytest.mark.parametrize(("week", "year", "woy"), WEEK_TABLE)
def test_week_table(week: int, year: int, woy: int) -> None:
    assert (year_of(week), week_of_year(week)) == (year, woy)
    assert year_start(year) - 1 + woy == week
    assert year_start(year) <= week <= year_end(year)
    assert abs_week(year, woy) == week
    assert plan_year_end_week(week) == year_end(year)
    assert plan_year_start_week(week) == year_start(year)
    assert weeks_left_in_year(week) == year_end(year) - week


def test_iso_week_53_folds_into_52_and_pre_base_is_week_1() -> None:
    assert abs_week(2026, 53) == 52  # 28 Dec 2026 - 3 Jan 2027
    assert abs_week(2032, 53) == 364  # 27 Dec 2032 - 2 Jan 2033
    assert abs_week(2027, 1) == 53
    assert abs_week(2025, 40) == 1
    assert year_relative_to_abs(2027, 5) == 57
    assert year_relative_to_abs(2025, 52) == 0
    for bad in (0, 54):
        with pytest.raises(ValueError):
            abs_week(2027, bad)
    with pytest.raises(ValueError):
        year_of(0)
    with pytest.raises(TypeError):
        year_of(True)
    with pytest.raises(ValueError):
        year_start(2025)


@pytest.mark.parametrize("n", [1, 5, 10])
@pytest.mark.parametrize("cw", CLOCK_WEEKS)
def test_horizon_for(cw: int, n: int) -> None:
    assert horizon_for(cw, n) == cw + 52 * n
    assert cp_sat_window(plan_year_end_week(cw), horizon_for(cw, n)) == min(
        plan_year_end_week(cw) + 26, cw + 52 * n
    )


@pytest.mark.parametrize("bad", [0, 11, -1, True, 5.0, "5"])
def test_horizon_years_domain(bad: object) -> None:
    with pytest.raises((ValueError, TypeError)):
        check_horizon_years(bad)
    with pytest.raises((ValueError, TypeError)):
        horizon_for(47, bad)  # type: ignore[arg-type]
    assert horizon_for(47) == 47 + 52 * DEFAULT_HORIZON_YEARS == 307


def test_year_windows_and_presets() -> None:
    assert list(year_windows(47, 52)) == [(2026, 47, 52)]
    assert list(year_windows(47, 120)) == [(2026, 47, 52), (2027, 53, 104), (2028, 105, 120)]
    assert list(year_windows(60, 50)) == []
    assert plan_until_presets(47, 307) == (
        (2026, 52),
        (2027, 104),
        (2028, 156),
        (2029, 208),
        (2030, 260),
    )
    assert plan_until_presets(53, 105) == ((2027, 104),)


def test_band_sets_match_domain_constants() -> None:
    for status in (*dc.SCHEDULABLE_STATUS_ORDER, "Commercialized", "On Hold", "Draft"):
        for prio in (*dc.PRIORITY_ORDER, None):
            old_negation = not dc.counts_toward_year(prio, status)  # pre-P53 R42-4
            assert queue_tier(prio, status) == old_negation, (prio, status)
            assert counts_toward_year(prio, status) == (
                not (status in dc.SCHEDULABLE_STATUS_ORDER and prio in dc.NOT_SCHEDULED_PRIORITIES)
            )
    assert counts_toward_year("P3", "In Queue") and queue_tier("P3", "In Queue")
    assert not counts_toward_year("P4", "In Queue") and queue_tier("P4", "In Queue")


def test_no_scheduling_module_reads_a_fixed_year_bound() -> None:
    """R53-8 / I58: no solve path reads `WITHIN_YEAR_WEEK`, `HORIZON_WEEKS` or
    the retired plan-import bounds."""

    banned = {"WITHIN_YEAR_WEEK", "HORIZON_WEEKS", "PLAN_UNTIL_MAX_WEEK", "PLAN_YEAR_END_WEEKS"}
    offenders: list[str] = []
    for path in sorted(Path(scheduling.__file__).parent.glob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Attribute) and node.attr in banned:
                offenders.append(f"{path.name}:{node.lineno}")
            if isinstance(node, ast.Name) and node.id in banned:
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == []


# =====================================================================================
# R53-2 / I57 / I58: the open horizon at every clock week
# =====================================================================================


@pytest.mark.parametrize("cw", CLOCK_WEEKS)
def test_defaults_follow_the_clock_week(cw: int) -> None:
    si = _si(*_chain(3), current_week=cw)
    assert si.within_year_week == year_end(year_of(cw))
    assert si.horizon_weeks == cw + 260
    assert check_i57_run_weeks(si) == ()
    assert check_i58_horizon(si, 5) == ()
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out, run_week=cw) == ()
    assert all(s.start_week >= cw for o in out.project_outcomes for s in o.steps)
    # Three 2-week designs on one leader + 3-week labs: done within 9 weeks of cw.
    assert all(not o.left_out for o in out.project_outcomes)
    rows = delivery_rows(si, out)
    table = delivery_by_year(rows, run_week=cw)
    assert table.plan_year == year_of(cw)
    assert check_i59_delivery(rows, table, run_week=cw, within_year_week=si.within_year_week) == ()


@pytest.mark.parametrize("n", [1, 5, 10])
def test_left_out_iff_no_slot_within_h(n: int) -> None:
    # 40 serial projects x 2 design weeks = 80 leader weeks from W47.
    si = _si(*_chain(40), horizon_weeks=horizon_for(47, n))
    out = run_greedy_sgs(si)
    assert check_i58_horizon(si, n) == ()
    assert validate_invariants(si, out) == ()
    left = [o for o in out.project_outcomes if o.left_out]
    if n == 1:
        assert left, "a 52-week search cannot hold 80 leader weeks"
        assert {outcome_left_out_reason(o) for o in left} == {"beyond_horizon"}
    else:
        assert not left
    for o in out.project_outcomes:
        assert all(s.end_week <= si.horizon_weeks for s in o.steps)
    with pytest.raises(AssertionError):
        assert check_i58_horizon(si, n % 10 + 1) == ()


def test_i57_flags_a_live_cut_off_that_is_not_the_year_end() -> None:
    si = _si(base_project(), current_week=53, within_year_week=52, horizon_weeks=313)
    assert [v.invariant for v in check_i57_run_weeks(si)] == ["I57", "I57"]
    imp = _si(base_project(), current_week=53, within_year_week=70)
    assert check_i57_run_weeks(imp, live=False) == ()
    assert [v.invariant for v in check_i57_run_weeks(imp)] == ["I57"]


def test_i58_flags_a_row_past_the_horizon() -> None:
    si = _si(base_project())
    out = run_greedy_sgs(si)
    o = out.project_outcomes[0]
    late = dataclasses.replace(o.steps[-1], end_week=si.horizon_weeks + 1)
    forged = dataclasses.replace(
        out, project_outcomes=(dataclasses.replace(o, steps=(o.steps[0], late)),)
    )
    assert "I58" in {v.invariant for v in validate_invariants(si, forged, check_determinism=False)}


def test_queued_p3_counts_but_keeps_its_place_at_the_back() -> None:
    q = base_project(project_id="a-q", priority="P3", status="In Queue", is_vip=True)
    p1 = base_project(project_id="z-p1", priority="P1", status="In Development")
    si = _si(q, p1, current_week=31)
    for out in (run_greedy_sgs(si), _cp(si)[0]):
        b = _by(out)
        assert out.scheduling_order == ("z-p1", "a-q")
        assert b["a-q"].counts_toward_year and b["a-q"].within_year
        assert b["a-q"].steps[0].start_week > b["z-p1"].steps[0].end_week
        assert validate_invariants(si, out, check_determinism=False) == ()


# =====================================================================================
# R53-2b / I61: the delivered year of a Commercialized project
# =====================================================================================


@pytest.mark.parametrize(
    ("cw", "actual_end", "within"),
    [
        (47, None, True),  # 2026, no date -> 2026: the pre-P53 rule
        (47, 10, True),
        (53, None, False),  # 2027, no date -> delivered in 2026
        (53, 52, False),  # ended in 2026
        (53, 53, True),
        (104, 60, True),
        (105, 104, False),
        (365, 364, False),
    ],
)
def test_commercialized_delivered_year(cw: int, actual_end: int | None, within: bool) -> None:
    assert commercialized_within_year(actual_end, cw) is within
    p = base_project(project_id="c", status="Commercialized", actual_end_week=actual_end)
    si = _si(p, current_week=cw)
    for out in (run_greedy_sgs(si), _cp(si)[0]):
        o = out.project_outcomes[0]
        assert o.excluded and o.within_year is within and not o.spillover
        assert validate_invariants(si, out, check_determinism=False) == ()
    forged = dataclasses.replace(
        out, project_outcomes=(dataclasses.replace(o, within_year=not within),)
    )
    assert "I9" in {v.invariant for v in validate_invariants(si, forged, check_determinism=False)}


def test_actual_end_week_is_omitted_from_the_canonical_input_at_none() -> None:
    from scheduling.workflow import canonical_schedule_input_asdict

    plain = canonical_schedule_input_asdict(_si(base_project()))
    assert "actual_end_week" not in plain["projects"][0]
    set_ = canonical_schedule_input_asdict(
        _si(base_project(status="Commercialized", actual_end_week=40))
    )
    assert set_["projects"][0]["actual_end_week"] == 40


# =====================================================================================
# R53-5 / I60: CP-SAT window plus the greedy tail
# =====================================================================================


def test_cp_sat_tail_places_what_the_window_cannot_hold() -> None:
    # 16 serial 2-week designs from W50: the leader is busy to W81 > W_cp 78.
    si = _si(*_chain(16), current_week=50)
    assert cp_sat_window(si.within_year_week, si.horizon_weeks) == 78
    out, info = _cp(si)
    g = run_greedy_sgs(si)
    assert info.num_tail_walked > 0
    assert set(info.tail_project_ids) <= set(info.model_project_ids)
    assert check_i60_cp_sat_tail(si, out, info) == ()
    assert validate_invariants(si, out, check_determinism=False) == ()
    assert not any(o.left_out for o in out.project_outcomes)
    assert not any(o.left_out for o in g.project_outcomes)
    b = _by(out)
    for pid in info.model_project_ids:
        if pid not in info.tail_project_ids:
            assert all(s.end_week <= 78 for s in b[pid].steps)
    # Deterministic given the model output (I8 / I60).
    out2, info2 = _cp(si)
    assert out2 == out and info2.tail_project_ids == info.tail_project_ids
    # Same model as a pre-P53 run over the same projects: with H = 78 the tail
    # cannot place them and they stay LEFT_OUT; every model placement is
    # identical.
    short = dataclasses.replace(si, horizon_weeks=78)
    s_out, s_info = _cp(short)
    assert s_info.model_project_ids == info.model_project_ids
    sb = _by(s_out)
    for pid in info.model_project_ids:
        if pid not in info.tail_project_ids:
            assert sb[pid] == b[pid]
        else:
            assert sb[pid].left_out


def test_i60_flags_a_model_placement_outside_the_window_and_a_bad_tail_order() -> None:
    si = _si(*_chain(16), current_week=50)
    out, info = _cp(si)
    placed = next(p for p in info.model_project_ids if p not in info.tail_project_ids)
    b = _by(out)
    o = b[placed]
    moved = dataclasses.replace(
        o, steps=tuple(dataclasses.replace(s, end_week=90) for s in o.steps)
    )
    forged = dataclasses.replace(
        out,
        project_outcomes=tuple(
            moved if x.project_id == placed else x for x in out.project_outcomes
        ),
    )
    assert {v.invariant for v in check_i60_cp_sat_tail(si, forged, info)} == {"I60"}
    rev = dataclasses.replace(info, tail_project_ids=tuple(reversed(info.tail_project_ids)))
    if len(info.tail_project_ids) > 1:
        assert check_i60_cp_sat_tail(si, out, rev)


def test_cp_sat_tail_on_the_seed_and_band_neutrality() -> None:
    seed = load_seed_schedule_input()
    out, info = _cp(seed)
    assert check_i60_cp_sat_tail(seed, out, info) == ()
    assert validate_invariants(seed, out, check_determinism=False) == ()
    assert scheduling.check_band_neutrality(seed, "cp_sat", **CP_KW) == ()


# =====================================================================================
# Monte Carlo searches to H
# =====================================================================================


def test_monte_carlo_uses_the_input_horizon() -> None:
    si = _si(*_chain(40), current_week=31)
    fc = {f.project_id: f for f in forecast_delivery(si, iterations=4, seed=7).project_forecasts}
    assert all(f.iterations_left_out == 0 for f in fc.values())
    assert max(f.max_completion_week or 0 for f in fc.values()) > 78
    short = dataclasses.replace(si, horizon_weeks=78)
    fs = forecast_delivery(short, iterations=4, seed=7).project_forecasts
    assert any(f.iterations_left_out for f in fs)


# =====================================================================================
# R53-3 / I59: delivery by year
# =====================================================================================


def test_delivery_by_year_years_bands_and_reasons() -> None:
    projects = (
        *_chain(40, priority="P2"),
        base_project(project_id="q3", priority="P3", status="In Queue"),
        base_project(project_id="p4", priority="P4"),
        base_project(project_id="nolead", leader_engineer_id="ghost"),
        base_project(project_id="com", status="Commercialized", priority="P4", actual_end_week=50),
    )
    si = _si(*projects)
    out = run_greedy_sgs(si)
    rows = delivery_rows(si, out)
    t = delivery_by_year(rows, run_week=47)
    assert check_i59_delivery(rows, t, run_week=47, within_year_week=si.within_year_week) == ()
    assert [y.year for y in t.years] == [2026, 2027, 2028]
    assert [y.indicative for y in t.years] == [False, False, True]
    assert t.years[0].counts.other == 1 and "com" in t.years[0].counts.project_ids["other"]
    assert t.not_placed.total == 1 and t.not_placed_by_reason["no_leader"].total == 1
    assert set(t.not_placed_by_reason) == set(LEFT_OUT_REASONS)
    listed = {pid for y in t.years for ids in y.counts.project_ids.values() for pid in ids}
    assert "p4" not in listed and "q3" in listed
    within = sum(1 for o in out.project_outcomes if o.within_year and not o.blocked)
    assert t.years[0].counts.total == within
    assert t.years[-1].cumulative.total == sum(y.counts.total for y in t.years)
    assert delivery_by_year(reversed(rows), run_week=47) == t


def test_delivery_by_year_on_the_seed_reconciles() -> None:
    seed = load_seed_schedule_input()
    for out in (run_greedy_sgs(seed), _cp(seed)[0]):
        rows = delivery_rows(seed, out)
        t = delivery_by_year(rows, run_week=seed.current_week)
        assert (
            check_i59_delivery(
                rows, t, run_week=seed.current_week, within_year_week=seed.within_year_week
            )
            == ()
        )


def test_i59_catches_a_forged_table() -> None:
    si = _si(*_chain(40))
    out = run_greedy_sgs(si)
    rows = delivery_rows(si, out)
    t = delivery_by_year(rows, run_week=47)
    y0 = t.years[0]
    bad_counts = dataclasses.replace(y0.counts, p1=y0.counts.p1 + 1)
    forged = dataclasses.replace(
        t, years=(dataclasses.replace(y0, counts=bad_counts), *t.years[1:])
    )
    assert {
        v.invariant for v in check_i59_delivery(rows, forged, run_week=47, within_year_week=52)
    } == {"I59"}


def test_delivery_rows_for_an_import_cut_off_use_calendar_years() -> None:
    # u = 70: "within" = by W70, but the table still splits by calendar year.
    rows = (
        DeliveryRow("a", "P1", True, False, False, True, False, False, 60),
        DeliveryRow("b", "P2", True, False, False, True, False, False, 40),
        DeliveryRow("c", "P3", True, False, False, False, True, False, 200),
    )
    t = delivery_by_year(rows, run_week=31)
    assert [(y.year, y.counts.total) for y in t.years] == [
        (2026, 1),
        (2027, 1),
        (2028, 0),
        (2029, 1),
    ]
    assert check_i59_delivery(rows, t, run_week=31, within_year_week=70) == ()


def test_left_out_reason_precedence() -> None:
    assert left_out_reason(
        left_out=True, no_leader=True, no_chamber_step_id="x", data_error=None
    ) == ("no_leader")
    assert left_out_reason(
        left_out=True, no_leader=False, no_chamber_step_id="x", data_error=None
    ) == ("no_chamber")
    assert left_out_reason(
        left_out=False, no_leader=False, no_chamber_step_id=None, data_error="e"
    ) == ("data_error")
    assert left_out_reason(
        left_out=True, no_leader=False, no_chamber_step_id=None, data_error=None
    ) == ("beyond_horizon")
    assert (
        left_out_reason(left_out=False, no_leader=False, no_chamber_step_id=None, data_error=None)
        is None
    )


# =====================================================================================
# R53-9 / I63: far_finish and leader_overloaded
# =====================================================================================


def test_tail_flags_and_i63() -> None:
    si = _si(*_chain(80), current_week=47)  # 160 leader weeks: past 2027
    before = repr(si)
    out = run_greedy_sgs(si)
    far, tails = tail_flags(si, out)
    assert repr(si) == before
    assert far and all(year_of(_by(out)[p].projected_end_week or 0) >= 2028 for p in far)
    [t] = tails
    assert t.engineer_id == "eng-a" and t.overloaded and t.leader_tail_week > year_end(2027)
    assert t.far_finish_projects == len(far)
    assert check_i63_tail_flags(si, out) == ()
    # Never an input: a second solve is byte-identical.
    assert run_greedy_sgs(si) == out
    assert not far_finish(scheduled=True, completion_week=104, run_week=47)
    assert far_finish(scheduled=True, completion_week=105, run_week=47)
    assert not far_finish(scheduled=False, completion_week=300, run_week=47)
    assert (
        leader_tails(
            run_week=47,
            design_rows=[("e", 50)],
            project_leaders=[("p", "e")],
            far_finish_project_ids=(),
        )[0].overloaded
        is False
    )


# =====================================================================================
# What-if supply at a 2027 clock (plan-year window on the absolute line)
# =====================================================================================


def test_whatif_supply_uses_the_plan_year_window() -> None:
    from scheduling.whatif import _hub_figures, _supply

    a = _hub_figures(None, 47)
    b = _hub_figures(None, 47 + 52)
    assert a == b  # remaining = 52 - week_of_year(cw), same in 2026 and 2027
    sa = _supply((ENGINEER_A,), (CHAMBER_GR1,), (), (), 47)
    sb = _supply((ENGINEER_A,), (CHAMBER_GR1,), (), (), 99)
    assert sa.lab_remaining_fraction == sb.lab_remaining_fraction == 5 / 52


# =====================================================================================
# R53-2 performance acceptance: N = 10 on the seed (recorded in MEMORY P53-T02)
# =====================================================================================


def test_greedy_n10_runtime_on_the_seed() -> None:
    seed = load_seed_schedule_input()
    si = dataclasses.replace(seed, horizon_weeks=horizon_for(seed.current_week, 10))
    t0 = time.perf_counter()
    out = run_greedy_sgs(si)
    elapsed = time.perf_counter() - t0
    assert validate_invariants(si, out, check_determinism=False) == ()
    assert elapsed < 5.0
