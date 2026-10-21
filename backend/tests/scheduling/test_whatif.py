"""P18-T01 -- what-if planning engine (scheduling.whatif, ADR 0031).

Hand-worked figures use the tiny baseline (`_whatif_fixtures.tiny_baseline`):

    R&D-Greece, 1 engineer x 1.0 FTE, calendar 5 d/wk with 10 holiday days
        deduction = 10 / 5 = 2 wk, working weeks per engineer = 50
    Greece lab: 1 chamber, 2 platforms, efficiency 0.8, maintenance 2,
        breakdown 1, calibration 1, region holiday 10 / 5 = 2
        working = 52 - 2 - 2 - 1 - 1 = 46, efficient = 46 x 0.8 x 2 = 73.6
    PDD / A: design 1+4+1+6+2+1+2+1 = 18 wk, lab 4+6 = 10 wk, critical path 38
    PDD / B: design 1+0+1+4+0+1+2+1 = 10 wk, lab 6 wk, critical path 18
    PDD / C: design 1+1+2+1+1 = 6 wk, lab 1 wk, critical path 8
"""

from __future__ import annotations

import dataclasses
import json

import pytest

import domain_constants as dc
from scheduling import ProjectInput, run_greedy_sgs, validate_invariants
from scheduling.whatif import (
    HARD_MAX_RUNS,
    MAX_ADDED_CHAMBERS_TOTAL,
    MAX_ADDED_DESIGNERS_TOTAL,
    MAX_ADDED_PROJECTS_TOTAL,
    MAX_REMOVED_DESIGNERS_TOTAL,
    AddChamber,
    AddEngineer,
    AddProject,
    ChamberDowntimeChange,
    HubCalendarInput,
    RemoveEngineerCount,
    Scenario,
    WhatIfBaseline,
    WhatIfBudgetExceeded,
    _min_units,
    analytic_requirements,
    apply_scenario,
    build_scenario_input,
    scenario_with_additions,
    simulate,
    solve_minimum_additions,
    to_jsonable,
    touched_scope,
)
from tests.scheduling._whatif_fixtures import (
    CURRENT_WEEK,
    ENGINEER_NAME_MARKER,
    portfolio_baseline,
    tiny_baseline,
)

# =====================================================================================
# Analytic path -- hand-worked
# =====================================================================================


def _design(req, hub="R&D-Greece"):
    return next(r for r in req.design if r.hub == hub)


def _lab(req, region="Greece"):
    return next(r for r in req.lab if r.lab_region == region)


def test_extra_weeks_are_sums_of_lead_time_durations():
    req = analytic_requirements(
        tiny_baseline(), Scenario(add_projects=(AddProject("R&D-Greece", "A", count=10),))
    )
    assert req.extra_design_weeks_total == 180  # 10 x 18
    assert req.extra_lab_weeks_total == 100.0  # 10 x 10
    assert _design(req).extra_design_weeks == 180
    assert _lab(req).extra_lab_weeks == 100.0


def test_mixed_categories_sum():
    sc = Scenario(
        add_projects=(
            AddProject("R&D-Greece", "A", count=2),  # 2 x 18 design, 2 x 10 lab
            AddProject("R&D-Greece", "B", count=3),  # 3 x 10 design, 3 x 6 lab
            AddProject("R&D-Greece", "C", count=4),  # 4 x 6 design, 4 x 1 lab
        )
    )
    req = analytic_requirements(tiny_baseline(), sc)
    assert req.extra_design_weeks_total == 36 + 30 + 24
    assert req.extra_lab_weeks_total == 20 + 18 + 4


def test_certification_off_removes_lab_weeks():
    sc = Scenario(
        add_projects=(AddProject("R&D-Greece", "A", count=2, certification_testing_required=False),)
    )
    req = analytic_requirements(tiny_baseline(), sc)
    assert req.extra_lab_weeks_total == 0.0
    assert req.extra_design_weeks_total == 36


def test_oem_workflow_uses_oem_lead_times():
    # OEM / A-OEM row (1,1,1,2,2,2,4,6,0,1,0,0,0,1): design A1 B1 D2 G4 I0 J1 = 9,
    # lab E2 + H6 = 8 (OEM hubs use the Greece chambers).
    req = analytic_requirements(
        portfolio_baseline(), Scenario(add_projects=(AddProject("OEM-HCK", "A-OEM"),))
    )
    assert _design(req, "OEM-HCK").extra_design_weeks == 9
    assert _lab(req, "Greece").extra_lab_weeks == 8.0


def test_ceilings_ten_projects():
    """10 x A: design load 180 vs 50 wk/FTE -> 1 FTE = 360 % ; need FTE > 3.6, so
    4 FTE in total, 3 extra. Lab load 100 vs 73.6 -> 135.87 % ; one more chamber
    gives 147.2 > 100 so 1 extra."""

    req = analytic_requirements(
        tiny_baseline(), Scenario(add_projects=(AddProject("R&D-Greece", "A", count=10),))
    )
    d = _design(req)
    assert d.working_weeks_per_engineer == 50.0
    assert d.capacity_after_scenario == 50.0
    assert d.booked_pct_after == 360.0
    assert d.status_after == "full"
    assert d.min_extra_designers == 3
    lab = _lab(req)
    assert lab.capacity_after_scenario == 73.6
    assert lab.booked_pct_after == 135.87
    assert lab.efficient_lab_weeks_per_new_chamber == 73.6
    assert lab.min_extra_chambers == 1
    assert req.min_extra_designers_total == 3
    assert req.min_extra_chambers_total == 1


def test_ceilings_thirty_projects():
    """30 x A: design 540 -> FTE > 10.8 -> 11 total, 10 extra. Lab 300 ->
    73.6 x k > 300 -> k = 5 chambers, 4 extra."""

    req = analytic_requirements(
        tiny_baseline(), Scenario(add_projects=(AddProject("R&D-Greece", "A", count=30),))
    )
    assert _design(req).min_extra_designers == 10
    assert _lab(req).min_extra_chambers == 4


def test_booked_exactly_100_is_full_so_one_more_unit_is_needed():
    # load 100, capacity 50 per unit, base 50: 1 extra gives exactly 100 % (full) so 2.
    assert _min_units(100.0, 50.0, 50.0, 100.0) == (2, True)
    # load 99 -> 1 extra gives 101 cap: 98.02 % -> ok
    assert _min_units(99.0, 50.0, 50.0, 100.0) == (1, True)
    assert _min_units(0.0, 0.0, 50.0, 100.0) == (0, True)
    assert _min_units(10.0, 0.0, 0.0, 100.0)[1] is False


def test_designer_fte_scales_the_count():
    sc = Scenario(add_projects=(AddProject("R&D-Greece", "A", count=10),))
    half = analytic_requirements(tiny_baseline(), sc, designer_fte=0.5)
    # 1 + 0.5 n > 3.6 -> n > 5.2 -> 6
    assert _design(half).min_extra_designers == 6
    assert _design(half).min_extra_fte == 3.0


def test_scenario_engineers_reduce_the_extra_needed():
    sc = Scenario(
        add_projects=(AddProject("R&D-Greece", "A", count=10),),
        add_engineers=(AddEngineer("R&D-Greece", fte=1.0, count=2),),
    )
    req = analytic_requirements(tiny_baseline(), sc)
    d = _design(req)
    assert d.fte_before == 1.0 and d.fte_after_scenario == 3.0
    assert d.capacity_after_scenario == 150.0
    assert d.booked_pct_after == 120.0
    assert d.min_extra_designers == 1  # 3 + 1 = 4 FTE > 3.6


def test_removed_engineers_lower_supply():
    base = tiny_baseline(engineers=4)
    sc = Scenario(
        add_projects=(AddProject("R&D-Greece", "A", count=10),),
        remove_engineer_counts=(RemoveEngineerCount("R&D-Greece", 1),),
    )
    d = _design(analytic_requirements(base, sc))
    assert d.fte_before == 4.0 and d.fte_after_scenario == 3.0
    assert d.min_extra_designers == 1


def test_downtime_change_lowers_lab_capacity():
    sc = Scenario(chamber_downtime=(ChamberDowntimeChange("c0", maintenance_weeks=10.0),))
    req = analytic_requirements(tiny_baseline(), sc)
    # working = 52 - 2 - 10 - 1 - 1 = 38 ; 38 x 0.8 x 2 = 60.8
    assert _lab(req).capacity_before == 73.6
    assert _lab(req).capacity_after_scenario == 60.8


def test_added_chamber_takes_the_region_norm():
    sc = Scenario(add_chambers=(AddChamber("Greece"),))
    lab = _lab(analytic_requirements(tiny_baseline(), sc))
    assert lab.chambers_before == 1 and lab.chambers_after_scenario == 2
    assert lab.capacity_after_scenario == 147.2


def test_added_chamber_overrides():
    sc = Scenario(add_chambers=(AddChamber("Greece", platforms=1, efficiency=1.0),))
    lab = _lab(analytic_requirements(tiny_baseline(), sc))
    # 46 working x 1.0 x 1 = 46 on top of 73.6 (norm downtime 2/1/1)
    assert lab.capacity_after_scenario == 119.6


def test_remaining_basis_uses_remaining_weeks():
    sc = Scenario(add_projects=(AddProject("R&D-Greece", "C", count=1),))
    req = analytic_requirements(tiny_baseline(), sc, basis="remaining")
    # remaining weeks = 52 - 31 = 21 ; remaining per engineer = 21 - 2 x 21/52 = 20.1923
    assert _design(req).capacity_after_scenario == 20.19
    assert _lab(req).capacity_after_scenario == round(73.6 * 21 / 52, 2)


def test_target_below_85_is_stricter():
    sc = Scenario(add_projects=(AddProject("R&D-Greece", "A", count=10),))
    strict = analytic_requirements(
        tiny_baseline(), sc, target_below_pct=float(dc.BOOKING_NEAR_FULL_PCT)
    )
    # capacity > 180 / 0.85 = 211.76 -> 5 FTE total -> 4 extra
    assert _design(strict).min_extra_designers == 4


def test_workings_show_the_arithmetic():
    req = analytic_requirements(
        tiny_baseline(), Scenario(add_projects=(AddProject("R&D-Greece", "A", count=10),))
    )
    text = "\n".join(req.workings)
    assert "10 x 18 wk (A)" in text
    assert "= 180" in text
    assert "ceil(" in text
    assert "3 designer(s)" in text
    assert "1 chamber(s)" in text


def test_analytic_is_integer_ceilings_and_float_free_counts():
    req = analytic_requirements(
        tiny_baseline(), Scenario(add_projects=(AddProject("R&D-Greece", "B", count=7),))
    )
    assert isinstance(req.min_extra_designers_total, int)
    assert isinstance(req.min_extra_chambers_total, int)
    assert isinstance(_design(req).extra_design_weeks, int)


def test_two_hubs_same_region_share_lab_load():
    base = portfolio_baseline()
    sc = Scenario(
        add_projects=(AddProject("R&D-India", "B", count=2), AddProject("PD-India", "B", count=3))
    )
    req = analytic_requirements(base, sc)
    india = _lab(req, "India")
    assert india.added_projects == 5
    assert india.extra_lab_weeks == 30.0  # 5 x 6
    assert _design(req, "R&D-India").extra_design_weeks == 20
    assert _design(req, "PD-India").extra_design_weeks == 30


def test_analytic_runs_the_baseline_scheduler_exactly_once(monkeypatch):
    """The "before" load is the active run's (D2): one greedy run of the
    unmodified baseline, never a run of the scenario world."""

    import scheduling.whatif as w

    calls = []
    real = w.run_greedy_sgs

    def counting(si):
        calls.append(len(si.projects))
        return real(si)

    monkeypatch.setattr(w, "run_greedy_sgs", counting)
    base = portfolio_baseline()
    analytic_requirements(base, Scenario(add_projects=(AddProject("R&D-Greece", "B", count=2),)))
    assert calls == [len(base.schedule.projects)]


# =====================================================================================
# Validation
# =====================================================================================


@pytest.mark.parametrize(
    "scenario",
    [
        Scenario(add_projects=(AddProject("Nowhere", "A"),)),
        Scenario(add_projects=(AddProject("R&D-Greece", "A-OEM"),)),
        Scenario(add_projects=(AddProject("OEM-HCK", "A"),)),
        Scenario(add_projects=(AddProject("R&D-Greece", "A", count=0),)),
        Scenario(add_projects=(AddProject("R&D-Greece", "A", status="Draft"),)),
        Scenario(add_projects=(AddProject("R&D-Greece", "A", priority="P9"),)),
        Scenario(add_projects=(AddProject("R&D-Greece", "A", workflow_id="OEM"),)),
        Scenario(add_engineers=(AddEngineer("R&D-Greece", fte=0.0),)),
        Scenario(remove_engineers=("no-such-engineer",)),
        Scenario(add_chambers=(AddChamber("Mars"),)),
        Scenario(chamber_downtime=(ChamberDowntimeChange("nope", 1.0),)),
        Scenario(priority_overrides=(("no-such-project", "P1"),)),
        Scenario(priority_overrides=(("p001", "P9"),)),
    ],
)
def test_invalid_scenarios_raise(scenario):
    with pytest.raises(ValueError):
        apply_scenario(portfolio_baseline(), scenario)


# =====================================================================================
# Applying a scenario
# =====================================================================================


def test_new_projects_default_to_in_queue_p3():
    inp = build_scenario_input(
        portfolio_baseline(), Scenario(add_projects=(AddProject("R&D-Greece", "B", count=2),))
    )
    new = [p for p in inp.projects if p.project_id.startswith("whatif-")]
    assert [p.project_id for p in new] == ["whatif-p001-001", "whatif-p001-002"]
    assert all(p.status == "In Queue" and p.priority == "P3" and not p.frozen for p in new)


def test_score_maps_to_band_and_priority_wins():
    sc = Scenario(
        add_projects=(
            AddProject("R&D-Greece", "B", score=72),
            AddProject("R&D-Greece", "B", score=56),
            AddProject("R&D-Greece", "B", score=41),
            AddProject("R&D-Greece", "B", score=10),
            AddProject("R&D-Greece", "B", score=99, priority="P4"),
        )
    )
    inp = build_scenario_input(portfolio_baseline(), sc)
    prios = [p.priority for p in inp.projects if p.project_id.startswith("whatif-")]
    assert prios == ["P1", "P2", "P3", "P4", "P4"]


def test_new_projects_go_to_the_added_engineer():
    sc = Scenario(
        add_projects=(AddProject("R&D-Greece", "B", count=2),),
        add_engineers=(AddEngineer("R&D-Greece", count=2),),
    )
    applied = apply_scenario(portfolio_baseline(), sc)
    leaders = {
        p.project_id: p.leader_engineer_id
        for p in applied.schedule_input.projects
        if p.project_id.startswith("whatif-")
    }
    # Added designers start at zero led load so they take the new projects.
    assert set(leaders.values()) == set(applied.added_engineer_ids)
    assert len(set(leaders.values())) == 2


def test_removed_engineers_projects_are_reassigned():
    base = portfolio_baseline()
    victim = "eng-R&D-Greece-0"
    sc = Scenario(remove_engineers=(victim,))
    applied = apply_scenario(base, sc)
    assert victim not in {e.engineer_id for e in applied.schedule_input.engineers}
    assert applied.removed_engineer_ids == (victim,)
    led_before = {p.project_id for p in base.schedule.projects if p.leader_engineer_id == victim}
    assert led_before and set(applied.reassigned_project_ids) == led_before
    for p in applied.schedule_input.projects:
        assert p.leader_engineer_id != victim


def test_remove_by_count_takes_the_least_loaded_engineers():
    base = portfolio_baseline()
    applied = apply_scenario(
        base, Scenario(remove_engineer_counts=(RemoveEngineerCount("OEM-HCK", 1),))
    )
    # OEM-HCK has one engineer: all its projects lose their leader.
    assert applied.removed_engineer_ids == ("eng-OEM-HCK-0",)
    out = run_greedy_sgs(applied.schedule_input)
    hck = {p.project_id for p in applied.schedule_input.projects if p.hub == "OEM-HCK"}
    assert all(o.left_out or o.no_leader for o in out.project_outcomes if o.project_id in hck)


def test_priority_override_applies_and_reorders():
    base = portfolio_baseline()
    pid = next(p.project_id for p in base.schedule.projects if p.priority == "P4")
    inp = build_scenario_input(base, Scenario(priority_overrides=((pid, "P1"),)))
    assert next(p for p in inp.projects if p.project_id == pid).priority == "P1"


# =====================================================================================
# Simulation
# =====================================================================================


def _snapshot(base: WhatIfBaseline) -> str:
    return json.dumps(dataclasses.asdict(base), sort_keys=True, default=str)


def test_zero_scenario_equals_baseline():
    base = portfolio_baseline()
    res = simulate(base, Scenario())
    assert res.diff.within_year_delta == 0
    assert res.diff.newly_slipping == () and res.diff.recovered == () and res.diff.moved == ()
    assert res.outcome_counts_before == res.outcome_counts_after
    assert res.utilization_before == res.utilization_after
    assert res.new_project_ids == ()
    # and the scenario input is the baseline input
    inp = build_scenario_input(base, Scenario())
    assert inp.projects == tuple(sorted(base.schedule.projects, key=lambda p: p.project_id))
    assert inp.engineers == tuple(sorted(base.schedule.engineers, key=lambda e: e.engineer_id))
    assert inp.chambers == tuple(sorted(base.schedule.chambers, key=lambda c: c.chamber_id))
    assert run_greedy_sgs(inp) == run_greedy_sgs(base.schedule)


_BUSY = Scenario(
    add_projects=(
        AddProject("R&D-Greece", "B", count=4, priority="P1"),
        AddProject("PD-Romania", "C", count=3),
    ),
    add_engineers=(AddEngineer("R&D-India", count=1),),
    remove_engineer_counts=(RemoveEngineerCount("PD-India", 1),),
    add_chambers=(AddChamber("Romania"),),
    chamber_downtime=(ChamberDowntimeChange("ch-gr-1", maintenance_weeks=8.0),),
)


def test_baseline_is_not_mutated():
    base = portfolio_baseline()
    before = _snapshot(base)
    simulate(base, _BUSY)
    analytic_requirements(base, _BUSY)
    solve_minimum_additions(base, _BUSY, "no_existing_slips")
    assert _snapshot(base) == before


def test_simulation_is_deterministic():
    base = portfolio_baseline()
    a = json.dumps(to_jsonable(simulate(base, _BUSY)), sort_keys=True)
    b = json.dumps(to_jsonable(simulate(base, _BUSY)), sort_keys=True)
    assert a == b
    s1 = json.dumps(to_jsonable(solve_minimum_additions(base, _BUSY)), sort_keys=True)
    s2 = json.dumps(to_jsonable(solve_minimum_additions(base, _BUSY)), sort_keys=True)
    assert s1 == s2
    r1 = json.dumps(to_jsonable(analytic_requirements(base, _BUSY)), sort_keys=True)
    r2 = json.dumps(to_jsonable(analytic_requirements(base, _BUSY)), sort_keys=True)
    assert r1 == r2


def test_input_order_does_not_matter():
    base = portfolio_baseline()
    si = base.schedule
    shuffled = dataclasses.replace(
        base,
        schedule=dataclasses.replace(
            si,
            projects=tuple(reversed(si.projects)),
            engineers=tuple(reversed(si.engineers)),
            chambers=tuple(reversed(si.chambers)),
        ),
        calendars=tuple(reversed(base.calendars)),
        chamber_supply=tuple(reversed(base.chamber_supply)),
    )
    a = json.dumps(to_jsonable(simulate(base, _BUSY)), sort_keys=True)
    b = json.dumps(to_jsonable(simulate(shuffled, _BUSY)), sort_keys=True)
    assert a == b


_INVARIANT_SCENARIOS = [
    Scenario(),
    _BUSY,
    Scenario(add_projects=(AddProject("OEM-HCK", "B-OEM", count=3),)),
    Scenario(add_projects=(AddProject("PD-India", "C", count=5, priority="P1"),)),
    Scenario(remove_engineer_counts=(RemoveEngineerCount("R&D-Greece", 2),)),
    Scenario(
        add_chambers=(AddChamber("India", count=2),), add_engineers=(AddEngineer("PD-India"),)
    ),
]


@pytest.mark.parametrize("scenario", _INVARIANT_SCENARIOS)
def test_invariants_hold_on_simulated_runs(scenario):
    inp = build_scenario_input(portfolio_baseline(), scenario)
    out = run_greedy_sgs(inp)
    violations = validate_invariants(inp, out)
    assert violations == ()


def test_invariants_hold_with_progress_and_frozen_in_the_baseline():
    from scheduling import StepProgressInput

    base = portfolio_baseline()
    projects = list(base.schedule.projects)
    projects[0] = dataclasses.replace(
        projects[0],
        step_progress=(StepProgressInput("PDD-A", "Done", 100, 25, 26, None),),
    )
    projects[1] = dataclasses.replace(projects[1], frozen=True, actual_start_week=33)
    base = dataclasses.replace(
        base, schedule=dataclasses.replace(base.schedule, projects=tuple(projects))
    )
    inp = build_scenario_input(base, _BUSY)
    assert validate_invariants(inp, run_greedy_sgs(inp)) == ()


def test_simulation_matches_the_real_scheduler():
    """No forked scheduling logic: the per-project outcome equals a direct
    `run_greedy_sgs` on the built input."""

    base = portfolio_baseline()
    res = simulate(base, _BUSY)
    inp = build_scenario_input(base, _BUSY)
    out = run_greedy_sgs(inp)
    by_id = {o.project_id: o for o in out.project_outcomes}
    assert len(res.projects) == len(out.project_outcomes)
    for r in res.projects:
        o = by_id[r.project_id]
        assert r.finish_week == o.projected_end_week
        assert r.within_year == o.within_year
    assert res.diff.within_year_after == sum(1 for o in out.project_outcomes if o.within_year)


def test_diff_lists_newly_slipping_existing_projects():
    base = portfolio_baseline()
    sc = Scenario(add_projects=(AddProject("R&D-Greece", "B", count=8, priority="P1"),))
    res = simulate(base, sc)
    assert res.diff.newly_slipping, "8 P1 projects must push existing Greece work out"
    for ch in res.diff.newly_slipping:
        assert ch.kind == "newly_slipping"
        assert ch.before_outcome == "within_year" and ch.after_outcome != "within_year"
    # delta bookkeeping: existing_after + new_within = after
    assert (
        res.diff.existing_within_year_after + res.diff.new_projects_within_year
        == res.diff.within_year_after
    )
    assert res.diff.within_year_before == res.diff.within_year_after - res.diff.within_year_delta
    assert all(not p.is_new or p.project_id.startswith("whatif-") for p in res.projects)


def test_outcome_classes_and_counts():
    res = simulate(portfolio_baseline(), _BUSY)
    assert sum(res.outcome_counts_after.values()) == len(res.projects)
    assert {p.outcome for p in res.projects} <= {
        "within_year",
        "spillover",
        "left_out",
        "blocked",
        "excluded",
        "data_error",
    }


def test_utilization_rows_follow_the_booked_rule():
    res = simulate(portfolio_baseline(), _BUSY)
    keys = [(u.scope, u.key) for u in res.utilization_after]
    assert keys == sorted(keys, key=lambda k: (k[0] != "hub", k[1]))
    for u in res.utilization_after:
        if u.capacity_year == 0:
            assert u.booked_pct_year is None
        else:
            assert u.booked_pct_year == round(u.load_weeks / u.capacity_year * 100, 2)
        if u.booked_pct_year is not None:
            expected = (
                "full"
                if u.booked_pct_year >= dc.BOOKING_FULL_PCT
                else "near_full"
                if u.booked_pct_year >= dc.BOOKING_NEAR_FULL_PCT
                else "available"
            )
            assert u.status_year == expected


def test_utilization_load_reconciles_with_i6_i7():
    from scheduling import compute_design_load_by_hub, compute_lab_load_by_hub

    base = portfolio_baseline()
    res = simulate(base, _BUSY)
    inp = build_scenario_input(base, _BUSY)
    out = run_greedy_sgs(inp)
    design = compute_design_load_by_hub(inp, out)
    lab_by_hub = compute_lab_load_by_hub(inp, out)
    for u in res.utilization_after:
        if u.scope == "hub":
            assert u.load_weeks == float(design.get(u.key, 0))
        else:
            expected = sum(v for h, v in lab_by_hub.items() if dc.HUB_LAB_REGION[h] == u.key)
            assert u.load_weeks == expected


def test_downtime_change_does_not_move_the_schedule():
    base = portfolio_baseline()
    res = simulate(
        base, Scenario(chamber_downtime=(ChamberDowntimeChange("ch-gr-1", maintenance_weeks=20.0),))
    )
    assert res.diff.moved == () and res.diff.within_year_delta == 0
    greece_before = next(u for u in res.utilization_before if u.key == "Greece")
    greece_after = next(u for u in res.utilization_after if u.key == "Greece")
    assert greece_after.capacity_year < greece_before.capacity_year
    assert greece_after.load_weeks == greece_before.load_weeks


def test_results_carry_no_names_or_financial_fields():
    res = simulate(portfolio_baseline(), _BUSY)
    blob = json.dumps(
        [
            to_jsonable(res),
            to_jsonable(analytic_requirements(portfolio_baseline(), _BUSY)),
            to_jsonable(solve_minimum_additions(portfolio_baseline(), _BUSY)),
        ]
    ).lower()
    for banned in (ENGINEER_NAME_MARKER.lower(), "tcogs", "margin", "selling", "customer"):
        assert banned not in blob


def test_no_leader_hub_leaves_new_projects_out():
    base = tiny_baseline(engineers=1)
    res = simulate(
        base,
        Scenario(
            add_projects=(AddProject("PD-Romania", "C"),),
        ),
    )
    new = [p for p in res.projects if p.is_new]
    assert new[0].outcome == "left_out"


def test_added_project_in_empty_world_finishes_per_lead_time():
    base = tiny_baseline(engineers=1)
    res = simulate(base, Scenario(add_projects=(AddProject("R&D-Greece", "C"),)))
    p = next(p for p in res.projects if p.is_new)
    # C: A1 D1 E2 H1 J1 K1 N1 (serial) from W31 -> 31 + 8 - 1 = 38
    assert p.unconstrained_end_week == 38
    assert p.outcome == "within_year" and p.finish_week == 38


def test_monotone_more_designers_never_reduce_within_year():
    base = portfolio_baseline()
    counts = []
    for n in range(0, 6):
        sc = Scenario(
            add_projects=(AddProject("R&D-Greece", "B", count=6, priority="P2"),),
            add_engineers=(AddEngineer("R&D-Greece", count=n),) if n else (),
        )
        counts.append(simulate(base, sc).diff.within_year_after)
    assert counts == sorted(counts), counts
    assert counts[-1] > counts[0]


def test_monotone_more_chambers_never_reduce_within_year():
    base = portfolio_baseline()
    counts = []
    for n in range(0, 5):
        sc = Scenario(
            add_projects=(AddProject("PD-India", "C", count=8, priority="P2"),),
            add_engineers=(AddEngineer("PD-India", count=3),),
            add_chambers=(AddChamber("India", count=n),) if n else (),
        )
        counts.append(simulate(base, sc).diff.within_year_after)
    assert counts == sorted(counts), counts


# =====================================================================================
# Minimum additions
# =====================================================================================

_GREECE_B8 = Scenario(add_projects=(AddProject("R&D-Greece", "B", count=8, priority="P2"),))


def test_zero_additions_when_target_already_met():
    base = tiny_baseline(engineers=2)
    r = solve_minimum_additions(
        base, Scenario(add_projects=(AddProject("R&D-Greece", "C", count=1),))
    )
    assert r.met and r.exact and not r.capped
    assert r.additions.total == 0
    assert r.runs_used == 2


def test_empty_scenario_meets_both_targets_trivially():
    base = portfolio_baseline()
    for target in ("all_new_within_year", "no_existing_slips"):
        r = solve_minimum_additions(base, Scenario(), target)
        assert r.met and r.additions.total == 0


@pytest.mark.parametrize("target", ["all_new_within_year", "no_existing_slips"])
def test_solver_finds_a_verified_minimum(target):
    base = portfolio_baseline()
    sc = Scenario(add_projects=(AddProject("R&D-Greece", "B", count=8, priority="P2"),))
    r = solve_minimum_additions(base, sc, target)
    assert r.met, r.workings
    assert not r.capped
    # `exact` is true only when every smaller combination was simulated (D3); the
    # drop-one-unit check below proves local minimality either way.
    assert r.runs_used <= r.run_cap <= HARD_MAX_RUNS
    assert r.additions.total >= 1

    # Re-simulating the recommendation really meets the target ...
    sc2 = scenario_with_additions(sc, r.additions)
    res = simulate(base, sc2)
    if target == "all_new_within_year":
        assert all(p.within_year for p in res.projects if p.is_new)
    else:
        assert res.diff.newly_slipping == ()
    inp = build_scenario_input(base, sc2)
    assert validate_invariants(inp, run_greedy_sgs(inp)) == ()

    # ... and no smaller total does (the search was exact): drop any one unit.
    for i, (hub, n) in enumerate(r.additions.designers):
        smaller = dataclasses.replace(
            r.additions,
            designers=tuple(
                (h, k - (1 if j == i else 0)) for j, (h, k) in enumerate(r.additions.designers)
            ),
        )
        s3 = simulate(base, scenario_with_additions(sc, _drop_zero(smaller)))
        if target == "all_new_within_year":
            assert not all(p.within_year for p in s3.projects if p.is_new), (hub, n)
        else:
            assert s3.diff.newly_slipping, (hub, n)


def _drop_zero(a):
    return dataclasses.replace(
        a,
        designers=tuple((h, n) for h, n in a.designers if n > 0),
        chambers=tuple((r, n) for r, n in a.chambers if n > 0),
    )


def test_solver_reports_the_two_hub_case():
    base = portfolio_baseline()
    sc = Scenario(
        add_projects=(
            AddProject("R&D-Greece", "B", count=6, priority="P2"),
            AddProject("PD-Romania", "B", count=6, priority="P2"),
        )
    )
    r = solve_minimum_additions(base, sc, "all_new_within_year")
    assert r.met
    assert set(h for h, _ in r.additions.designers) <= {"PD-Romania", "R&D-Greece"}
    assert r.searched_designer_hubs == ("PD-Romania", "R&D-Greece")


def test_run_cap_is_honoured_and_flagged():
    base = portfolio_baseline()
    sc = Scenario(add_projects=(AddProject("R&D-Greece", "B", count=25, priority="P1"),))
    r = solve_minimum_additions(base, sc, "all_new_within_year", max_runs=5)
    assert r.runs_used <= 5
    assert r.run_cap == 5
    assert r.capped
    assert not r.met
    assert r.achieved is not None


def test_run_cap_is_clamped_to_the_hard_maximum():
    base = portfolio_baseline()
    sc = Scenario(add_projects=(AddProject("R&D-Greece", "B", count=60, priority="P1"),))
    r = solve_minimum_additions(base, sc, "all_new_within_year", max_runs=10_000)
    assert r.run_cap == HARD_MAX_RUNS == 60
    assert r.runs_used <= 60


def test_lead_time_unattainable_projects_are_reported_not_searched():
    # PDD / A needs 38 wk from W31 -> W68, never within W52 whatever is added.
    base = portfolio_baseline()
    sc = Scenario(add_projects=(AddProject("R&D-Greece", "A", count=3),))
    r = solve_minimum_additions(base, sc, "all_new_within_year")
    assert len(r.unattainable_project_ids) == 3
    assert r.met_attainable and not r.met
    assert r.additions.total == 0
    assert any("cannot finish by W52" in w for w in r.workings)


def test_solver_rejects_bad_arguments():
    with pytest.raises(ValueError):
        solve_minimum_additions(portfolio_baseline(), Scenario(), "bogus")  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        solve_minimum_additions(portfolio_baseline(), Scenario(), designer_fte=0)


def test_solver_with_no_dimensions_says_so():
    base = portfolio_baseline()
    r = solve_minimum_additions(
        base,
        Scenario(add_chambers=(AddChamber("Greece"),)),
        "all_new_within_year",
    )
    assert r.met  # nothing to violate


def test_priority_override_slips_can_be_offset_by_designers():
    base = portfolio_baseline()
    # Promote several low-priority Greece projects to P1; others may slip.
    ids = [
        p.project_id
        for p in base.schedule.projects
        if p.hub == "R&D-Greece" and p.priority in ("P4", "Q")
    ][:4]
    sc = Scenario(priority_overrides=tuple((i, "P1") for i in ids))
    r = solve_minimum_additions(base, sc, "no_existing_slips")
    assert r.runs_used <= r.run_cap
    assert "R&D-Greece" in r.searched_designer_hubs


def test_current_week_pinned():
    assert portfolio_baseline().schedule.current_week == CURRENT_WEEK == 31


def test_projects_in_results_cover_baseline_plus_new():
    base = portfolio_baseline()
    res = simulate(base, _BUSY)
    assert len(res.projects) == len(base.schedule.projects) + 7
    assert {p.project_id for p in res.projects if p.is_new} == set(res.new_project_ids)
    assert isinstance(ProjectInput, type)


def test_two_pool_search_equals_brute_force_minimum():
    """The staircase result is the true minimum total (ties: fewer chambers)
    found by exhaustively simulating the whole grid."""

    base = portfolio_baseline()
    sc = Scenario(add_projects=(AddProject("R&D-Greece", "B", count=5, priority="P2"),))
    r = solve_minimum_additions(base, sc, "all_new_within_year")
    assert r.met

    best = None
    for des in range(0, 9):
        for ch in range(0, 5):
            add = dataclasses.replace(
                r.additions,
                designers=(("R&D-Greece", des),) if des else (),
                chambers=(("Greece", ch),) if ch else (),
            )
            res = simulate(base, scenario_with_additions(sc, add))
            if all(p.within_year for p in res.projects if p.is_new):
                key = (des + ch, ch, des)
                if best is None or key < best:
                    best = key
    assert best is not None
    assert r.additions.total == best[0]
    assert sum(n for _, n in r.additions.chambers) == best[1]


def test_three_pool_region_is_solved_and_verified():
    # R&D-Greece + OEM-HCK share the Greece chambers: 3 dimensions in one region.
    base = portfolio_baseline()
    sc = Scenario(
        add_projects=(
            AddProject("R&D-Greece", "C", count=4, priority="P2"),
            AddProject("OEM-HCK", "C-OEM", count=3, priority="P2"),
        )
    )
    r = solve_minimum_additions(base, sc, "all_new_within_year")
    assert r.runs_used <= r.run_cap
    assert r.searched_designer_hubs == ("OEM-HCK", "R&D-Greece")
    if r.met:
        res = simulate(base, scenario_with_additions(sc, r.additions))
        assert all(p.within_year for p in res.projects if p.is_new)


def test_regions_are_independent_so_totals_add_up():
    base = portfolio_baseline()
    greece = Scenario(add_projects=(AddProject("R&D-Greece", "B", count=5, priority="P2"),))
    romania = Scenario(add_projects=(AddProject("PD-Romania", "B", count=5, priority="P2"),))
    both = Scenario(add_projects=greece.add_projects + romania.add_projects)
    a = solve_minimum_additions(base, greece)
    b = solve_minimum_additions(base, romania)
    c = solve_minimum_additions(base, both)
    assert a.met and b.met and c.met
    assert c.additions.total == a.additions.total + b.additions.total


# =====================================================================================
# P18-R01 -- D2: "before" load is the active run's (single source with Capacity)
# =====================================================================================


def _stacked_baseline(n: int = 40) -> WhatIfBaseline:
    """One engineer leading `n` PDD/A projects: most are left out of the 78-week
    horizon, so the run books far less than the lead-time demand (n x 18 wk)."""

    ps = tuple(
        ProjectInput(f"x{i:02d}", f"X{i}", "R&D-Greece", "In Queue", "A", "P3", False, "e0")
        for i in range(n)
    )
    return tiny_baseline(projects=ps)


def _util(rows, scope, key):
    return next(u for u in rows if u.scope == scope and u.key == key)


@pytest.mark.parametrize("basis", ["year", "remaining"])
@pytest.mark.parametrize("make", [portfolio_baseline, _stacked_baseline])
def test_zero_scenario_estimate_before_equals_simulate_utilization(make, basis):
    base = make()
    req = analytic_requirements(base, Scenario(), basis=basis)
    sim = simulate(base, Scenario())
    assert req.design and req.lab
    for d in req.design:
        u = _util(sim.utilization_before, "hub", d.hub)
        assert d.baseline_load_weeks == u.load_weeks
        want = u.booked_pct_year if basis == "year" else u.booked_pct_remaining
        assert d.booked_pct_before == want
        assert d.booked_pct_after == want  # nothing added
    for lab in req.lab:
        u = _util(sim.utilization_before, "lab_region", lab.lab_region)
        assert lab.baseline_load_weeks == u.load_weeks
        want = u.booked_pct_year if basis == "year" else u.booked_pct_remaining
        assert lab.booked_pct_before == want


def test_before_load_excludes_what_the_run_does_not_book():
    base = _stacked_baseline()
    req = analytic_requirements(base, Scenario())
    d = _design(req)
    assert d.baseline_load_weeks < 40 * 18  # lead-time demand would be 720
    sim = simulate(base, Scenario())
    assert d.baseline_load_weeks == _util(sim.utilization_before, "hub", "R&D-Greece").load_weeks
    assert d.booked_pct_before == _util(sim.utilization_before, "hub", "R&D-Greece").booked_pct_year


def test_hand_example_run_load_plus_ten_pdd_a():
    """One PDD/A project in the run (18 design, 10 lab): +10 PDD/A gives
    18 + 180 = 198 vs 50 -> 396 %, need FTE > 3.96 -> 3 extra designers; lab
    10 + 100 = 110 vs 73.6 -> 149.46 %, one chamber (147.2) clears it."""

    p = ProjectInput("x1", "X", "R&D-Greece", "In Development", "A", "P2", False, "e0")
    base = tiny_baseline(projects=(p,))
    req = analytic_requirements(
        base, Scenario(add_projects=(AddProject("R&D-Greece", "A", count=10),))
    )
    d, lab = _design(req), _lab(req)
    assert (d.baseline_load_weeks, d.new_load_weeks) == (18.0, 198.0)
    assert (d.booked_pct_before, d.booked_pct_after) == (36.0, 396.0)
    assert d.min_extra_designers == 3
    assert (lab.baseline_load_weeks, lab.new_load_weeks) == (10.0, 110.0)
    assert (lab.booked_pct_before, lab.booked_pct_after) == (13.59, 149.46)
    assert lab.min_extra_chambers == 1


def test_extra_designers_follow_the_run_load_not_the_lead_time_demand():
    base = _stacked_baseline()
    sc = Scenario(add_projects=(AddProject("R&D-Greece", "C", count=5),))
    req = analytic_requirements(base, sc)
    d = _design(req)
    run_load = _util(simulate(base, Scenario()).utilization_before, "hub", "R&D-Greece").load_weeks
    assert d.new_load_weeks == run_load + 5 * 6
    # one more designer than reported would be too many, one fewer too few
    cap = d.capacity_after_scenario + 50 * d.min_extra_designers
    assert d.new_load_weeks / cap * 100 < 100
    if d.min_extra_designers:
        assert d.new_load_weeks / (cap - 50) * 100 >= 100


# =====================================================================================
# P18-R01 -- D2b: headline totals over the touched hubs / lab regions only
# =====================================================================================


def _deficit_baseline() -> WhatIfBaseline:
    """R&D-Greece already over-booked (capacity ~4 wk/FTE vs 18 wk load)."""

    p = ProjectInput("x1", "X", "R&D-Greece", "In Development", "A", "P2", False, "e0")
    base = tiny_baseline(projects=(p,))
    return dataclasses.replace(base, calendars=(HubCalendarInput("R&D-Greece", 5, 240, 0, 0, 0),))


def test_zero_scenario_totals_are_zero_even_with_existing_deficits():
    req = analytic_requirements(_deficit_baseline(), Scenario())
    assert _design(req).min_extra_designers > 0  # the deficit is real and still listed
    assert req.touched_hubs == () and req.touched_lab_regions == ()
    assert req.min_extra_designers_total == 0
    assert req.min_extra_chambers_total == 0
    assert req.extra_design_weeks_total == 0 and req.extra_lab_weeks_total == 0


def test_totals_cover_touched_hubs_and_regions_only():
    base = portfolio_baseline()
    sc = Scenario(add_projects=(AddProject("R&D-India", "B", count=3),))
    req = analytic_requirements(base, sc)
    assert req.touched_hubs == ("R&D-India",)
    assert req.touched_lab_regions == ("India",)
    # every hub / region keeps its row
    assert {r.hub for r in req.design} >= {"R&D-Greece", "PD-India", "R&D-India"}
    assert {r.lab_region for r in req.lab} >= {"Greece", "India", "Romania"}
    assert req.min_extra_designers_total == _design(req, "R&D-India").min_extra_designers
    assert req.min_extra_chambers_total == _lab(req, "India").min_extra_chambers
    assert req.extra_design_weeks_total == 30
    assert req.extra_lab_weeks_total == 18.0


def test_touched_scope_covers_every_scenario_part():
    base = portfolio_baseline()
    eng = next(e for e in base.schedule.engineers if e.hub == "PD-Romania")
    ch = next(c for c in base.schedule.chambers if c.lab_region == "Greece")
    proj = next(p for p in base.schedule.projects if p.hub == "OEM-HCK")
    assert touched_scope(base, Scenario(add_engineers=(AddEngineer("PD-India"),))) == (
        ("PD-India",),
        ("India",),
    )
    assert touched_scope(base, Scenario(remove_engineers=(eng.engineer_id,))) == (
        ("PD-Romania",),
        ("Romania",),
    )
    assert touched_scope(
        base, Scenario(remove_engineer_counts=(RemoveEngineerCount("R&D-India"),))
    ) == (
        ("R&D-India",),
        ("India",),
    )
    assert touched_scope(base, Scenario(add_chambers=(AddChamber("Romania"),))) == (
        (),
        ("Romania",),
    )
    assert touched_scope(
        base,
        Scenario(chamber_downtime=(ChamberDowntimeChange(ch.chamber_id, maintenance_weeks=3),)),
    ) == ((), ("Greece",))
    assert touched_scope(base, Scenario(priority_overrides=((proj.project_id, "P1"),))) == (
        ("OEM-HCK",),
        ("Greece",),
    )
    assert touched_scope(base, Scenario()) == ((), ())


def test_downtime_only_scenario_totals_cover_that_region_only():
    base = portfolio_baseline()
    sc = Scenario(chamber_downtime=(ChamberDowntimeChange("ch-in-1", maintenance_weeks=20),))
    req = analytic_requirements(base, sc)
    assert req.touched_hubs == () and req.touched_lab_regions == ("India",)
    assert req.min_extra_designers_total == 0
    assert req.min_extra_chambers_total == _lab(req, "India").min_extra_chambers


# =====================================================================================
# P18-R01 -- D3: `exact` means verified
# =====================================================================================


def _grid_minimum(base, sc, hub, region, target, d_max=9, c_max=5):
    from scheduling.whatif import _apply_units, _run_baseline, _simulate_with, _violators

    br = _run_baseline(base)
    dims = [("designer", hub), ("chamber", region)]
    best = None
    for d in range(d_max + 1):
        for c in range(c_max + 1):
            res = _simulate_with(base, _apply_units(sc, dims, (d, c), 1.0), br, 1)
            if not _violators(target, res, br)[0]:
                key = (d + c, c, d)
                if best is None or key < best:
                    best = key
    return best


def test_regression_cheaper_point_on_the_zero_chamber_axis_is_found():
    """Greedy is not monotone in chambers: with 25 chambers 5 designers are needed,
    with none only 4. A corner-first search proved 5 'exact'; the true minimum is 4
    designers and no chamber (found by brute force over the grid)."""

    base = portfolio_baseline(4)
    sc = Scenario(add_projects=(AddProject("R&D-India", "B", count=30, priority="P1"),))
    r = solve_minimum_additions(base, sc, "no_existing_slips")
    brute = _grid_minimum(base, sc, "R&D-India", "India", "no_existing_slips")
    assert brute == (4, 0, 4)
    assert r.met
    assert r.additions.total == 4
    assert r.additions.designers == (("R&D-India", 4),)
    assert r.additions.chambers == ()
    if r.exact:  # exact is only ever claimed when verified
        assert r.additions.total == brute[0]


def test_exact_is_verified_by_simulating_every_smaller_total():
    base = portfolio_baseline(4)
    sc = Scenario(add_projects=(AddProject("R&D-India", "B", count=10, priority="P1"),))
    r = solve_minimum_additions(base, sc, "no_existing_slips")
    brute = _grid_minimum(base, sc, "R&D-India", "India", "no_existing_slips")
    assert r.met and r.additions.total == brute[0]
    assert r.exact  # a small total: every smaller combination fits the run cap


def test_unverified_minimum_is_not_called_exact_and_says_why():
    base = portfolio_baseline()
    sc = Scenario(add_projects=(AddProject("R&D-Greece", "B", count=8, priority="P2"),))
    r = solve_minimum_additions(base, sc, "all_new_within_year")
    assert r.met and not r.capped
    assert not r.exact
    assert any("more capacity never hurts" in w for w in r.workings)


def test_exact_never_overclaims_against_brute_force():
    base = portfolio_baseline()
    for hub, region, cat, n in (
        ("R&D-Greece", "Greece", "C", 8),
        ("PD-Romania", "Romania", "C", 8),
        ("R&D-India", "India", "C", 15),
    ):
        sc = Scenario(add_projects=(AddProject(hub, cat, count=n, priority="P1"),))
        for target in ("all_new_within_year", "no_existing_slips"):
            r = solve_minimum_additions(base, sc, target)
            brute = _grid_minimum(base, sc, hub, region, target, 12, 5)
            if r.exact:
                assert brute is not None and r.additions.total == brute[0], (hub, target)


# =====================================================================================
# P18-R01 -- S18-M1: engine caps and cooperative deadline
# =====================================================================================


def test_cap_constants():
    assert (
        MAX_ADDED_PROJECTS_TOTAL,
        MAX_ADDED_DESIGNERS_TOTAL,
        MAX_REMOVED_DESIGNERS_TOTAL,
        MAX_ADDED_CHAMBERS_TOTAL,
    ) == (200, 50, 50, 20)


@pytest.mark.parametrize(
    "scenario",
    [
        Scenario(
            add_projects=(
                AddProject("R&D-Greece", "C", count=150),
                AddProject("PD-India", "C", count=51),
            )
        ),
        Scenario(
            add_engineers=(AddEngineer("PD-India", count=30), AddEngineer("R&D-India", count=21))
        ),
        Scenario(add_chambers=(AddChamber("India", count=11), AddChamber("Greece", count=10))),
        Scenario(remove_engineer_counts=(RemoveEngineerCount("PD-India", count=51),)),
    ],
)
def test_totals_beyond_the_caps_raise_in_every_entry_point(scenario):
    base = portfolio_baseline()
    for call in (
        lambda: simulate(base, scenario),
        lambda: analytic_requirements(base, scenario),
        lambda: solve_minimum_additions(base, scenario),
        lambda: apply_scenario(base, scenario),
    ):
        with pytest.raises(ValueError, match="at most"):
            call()


def test_exactly_at_the_caps_is_accepted():
    base = portfolio_baseline()
    sc = Scenario(
        add_projects=(
            AddProject("R&D-Greece", "C", count=100),
            AddProject("PD-India", "C", count=100),
        ),
        add_engineers=(AddEngineer("PD-India", count=50),),
        add_chambers=(AddChamber("India", count=20),),
    )
    res = simulate(base, sc)
    assert res.diff.new_projects_total == 200


def test_solver_additions_keep_the_scenario_resimulable():
    base = portfolio_baseline()
    sc = Scenario(
        add_engineers=(AddEngineer("R&D-Greece", count=MAX_ADDED_DESIGNERS_TOTAL),),
        add_projects=(AddProject("R&D-Greece", "B", count=20, priority="P2"),),
    )
    r = solve_minimum_additions(base, sc)
    assert sum(n for _, n in r.additions.designers) == 0  # no room: clamped to the cap
    simulate(base, scenario_with_additions(sc, r.additions))  # must not raise


class _TickClock:
    """Fake clock: every read advances one second."""

    def __init__(self) -> None:
        self.t = 0.0
        self.reads = 0

    def __call__(self) -> float:
        self.reads += 1
        self.t += 1.0
        return self.t


def test_deadline_stops_simulate_analytic_and_solve():
    base = portfolio_baseline()
    sc = Scenario(add_projects=(AddProject("R&D-Greece", "B", count=8, priority="P2"),))
    with pytest.raises(WhatIfBudgetExceeded):
        simulate(base, sc, deadline_s=3, clock=_TickClock())
    with pytest.raises(WhatIfBudgetExceeded):
        analytic_requirements(base, sc, deadline_s=2, clock=_TickClock())
    clock = _TickClock()
    with pytest.raises(WhatIfBudgetExceeded):
        solve_minimum_additions(base, sc, deadline_s=40, clock=clock)
    assert clock.reads >= 40  # it checked cooperatively, between runs


def test_a_generous_deadline_changes_nothing_and_no_deadline_reads_no_clock():
    base = portfolio_baseline()
    sc = Scenario(add_projects=(AddProject("R&D-Greece", "C", count=3),))

    def forbidden() -> float:
        raise AssertionError("no deadline -> the clock must not be read")

    plain = to_jsonable(simulate(base, sc, clock=forbidden))
    ticking = to_jsonable(simulate(base, sc, deadline_s=1e9, clock=lambda: 0.0))
    assert json.dumps(plain, sort_keys=True) == json.dumps(ticking, sort_keys=True)
    solve_minimum_additions(base, sc, clock=forbidden)


def test_bad_deadline_is_rejected():
    with pytest.raises(ValueError):
        simulate(portfolio_baseline(), Scenario(), deadline_s=0)
