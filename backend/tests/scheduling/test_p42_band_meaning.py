"""P42-T02 — priority band meaning in the scheduler (ADR 0056 as ruled at P42-T01,
R42-2..R42-9; DOMAIN_RULES "Priority band meaning").

- R42-3 / I49: a non-frozen P4 / Q project in a schedulable status is never
  scheduled (any solver, What-if, plan import), VIP or started or not; status
  exclusion is checked first.
- R42-2: a frozen P4 / Q project books its locked capacity, never counts.
- R42-4 / I50: `counts_toward_year` on every outcome; within_year / spillover
  are AND-ed with it.
- R42-5 / I51 / I52: sort key 1a; queued P3 only takes spare capacity; CP-SAT
  keeps queued projects out of the model and walks them after the solve.
- An input with no P4 / Q and no queued P3 is byte-identical to pre-P42.

Fixture arithmetic (tests/scheduling/_fixtures.py): PDD-A design 2 weeks on
the leader -> PDD-F lab 3 weeks on a chamber (max_concurrent 1).
Pure, in-process; no DB.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json

import pytest

import domain_constants as dc
import scheduling.invariants as inv
from scheduling import (
    LiveProjectRow,
    LiveStepRow,
    ProjectInput,
    ScheduleInput,
    check_band_neutrality,
    compute_demand_load,
    run_cp_sat,
    run_greedy_sgs,
    validate_invariants,
    without_spare_capacity_projects,
    year_flags,
)
from scheduling._selftest_common import SELFTEST_WEEK, load_seed_schedule_input
from scheduling.greedy import _sort_key, prepare_run, project_queue_tier
from scheduling.monte_carlo import forecast_delivery
from scheduling.plan_import import (
    ImportProject,
    PlanImportRequest,
    PlanImportResult,
    run_plan_import,
)
from scheduling.whatif import (
    AddEngineer,
    AddProject,
    RemoveEngineerCount,
    Scenario,
    analytic_requirements,
    classify_outcome,
    simulate,
    to_jsonable,
)
from scheduling.workflow import canonical_schedule_output_asdict
from tests.scheduling._fixtures import (
    CHAMBER_GR1,
    ENGINEER_A,
    ENGINEER_B,
    LEAD_TIMES,
    TEMPLATE,
    base_project,
    progress,
)
from tests.scheduling._whatif_fixtures import (
    portfolio_baseline,
    tiny_baseline,
    without_p53_r01_fields,
)

CP_KW = dict(deterministic_time=2.0, earliness_deterministic_time=1.0)


def _si(*projects: ProjectInput, **kw: object) -> ScheduleInput:
    return ScheduleInput(
        projects=projects,
        engineers=(ENGINEER_A, ENGINEER_B),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
        lead_times=LEAD_TIMES,
        **{"current_week": SELFTEST_WEEK, **kw},  # type: ignore[arg-type]
    )


def _by(out):
    return {o.project_id: o for o in out.project_outcomes}


def _step(outcome, sid: str):
    return next(s for s in outcome.steps if s.step_id == sid)


def _assert_not_scheduled(o) -> None:
    assert o.excluded and o.not_scheduled_priority and not o.counts_toward_year
    assert not (o.within_year or o.spillover or o.left_out or o.blocked or o.no_leader)
    assert o.steps == () and o.data_error is None and o.progress_pct is None
    assert (
        o.start_week,
        o.end_week,
        o.projected_end_week,
        o.expected_end_week,
        o.unconstrained_end_week,
    ) == (None,) * 5


# =====================================================================================
# Constants and the pure helpers
# =====================================================================================


def test_labels_and_not_scheduled_set() -> None:
    assert dict(dc.PRIORITY_LABELS) == {
        "P1": "Must do this year",
        "P2": "Good to have this year",
        "P3": "In queue",
        "P4": "Miscellaneous",
        "Q": "Unprioritised",
    }
    assert dc.NOT_SCHEDULED_PRIORITIES == frozenset({"P4", "Q"})


@pytest.mark.parametrize(
    ("priority", "status", "expected"),
    [
        ("P1", "In Queue", True),
        ("P2", "In Queue", True),
        ("P3", "In Queue", False),
        ("P3", "In Development", True),
        ("P3", "In Buyoff", True),
        ("P4", "In Development", False),
        ("Q", "In Queue", False),
        ("P4", "Commercialized", True),
        ("Q", "On Hold", True),
        ("P3", "Draft", True),
        (None, "Cancelled", True),
    ],
)
def test_counts_toward_year_truth_table(priority, status, expected) -> None:
    assert dc.counts_toward_year(priority, status) is expected


def test_year_flags() -> None:
    kw = dict(within_year_week=52)
    assert year_flags(counts_toward_year=True, scheduled=True, completion_week=52, **kw) == (
        True,
        False,
    )
    assert year_flags(counts_toward_year=True, scheduled=True, completion_week=53, **kw) == (
        False,
        True,
    )
    assert year_flags(counts_toward_year=False, scheduled=True, completion_week=40, **kw) == (
        False,
        False,
    )
    assert year_flags(counts_toward_year=True, scheduled=False, completion_week=None, **kw) == (
        False,
        False,
    )


# =====================================================================================
# R42-3 / I49: non-frozen P4 / Q is never scheduled
# =====================================================================================


@pytest.mark.parametrize("band", ["P4", "Q"])
@pytest.mark.parametrize("vip", [False, True])
def test_p4_and_q_are_never_scheduled_vip_or_not(band: str, vip: bool) -> None:
    p1 = base_project(project_id="p1", priority="P1")
    low = base_project(project_id="low", priority=band, is_vip=vip)
    si = _si(p1, low)
    for out in (run_greedy_sgs(si), run_cp_sat(si, **CP_KW)[0]):
        b = _by(out)
        _assert_not_scheduled(b["low"])
        assert "low" not in out.scheduling_order
        assert b["p1"].within_year and b["p1"].counts_toward_year
        assert validate_invariants(si, out, check_determinism=False) == ()
    assert "low" not in {p.project_id for p in prepare_run(si).ordered}


def test_started_p4_books_nothing_and_a_started_p3_schedules() -> None:
    """OQ #108 assumption: a started non-frozen P4 is not scheduled and its
    anchored stages are not pre-booked, so the P1 project takes eng-a at once."""

    started = (
        progress("PDD-A", "In Progress", percent_complete=50, actual_start_week=SELFTEST_WEEK - 1),
    )
    p1 = base_project(project_id="p1", priority="P1")
    p4 = base_project(
        project_id="p4", priority="P4", status="In Development", step_progress=started
    )
    p3 = base_project(
        project_id="p3",
        priority="P3",
        status="In Development",
        step_progress=started,
        leader_engineer_id="eng-b",
    )
    si = _si(p1, p4, p3)
    for out in (run_greedy_sgs(si), run_cp_sat(si, **CP_KW)[0]):
        b = _by(out)
        _assert_not_scheduled(b["p4"])
        assert _step(b["p1"], "PDD-A").start_week == SELFTEST_WEEK
        assert b["p3"].counts_toward_year and not b["p3"].excluded
        assert b["p3"].within_year and _step(b["p3"], "PDD-A").start_week == SELFTEST_WEEK - 1
        assert validate_invariants(si, out, check_determinism=False) == ()


def test_status_exclusion_is_checked_first() -> None:
    comm = base_project(project_id="c", priority="P4", status="Commercialized")
    hold = base_project(project_id="h", priority="Q", status="On Hold")
    out = run_greedy_sgs(_si(comm, hold))
    b = _by(out)
    for o in b.values():
        assert o.excluded and not o.not_scheduled_priority and o.counts_toward_year
    assert b["c"].within_year and not b["h"].within_year


# =====================================================================================
# R42-2: a frozen P4 books its locked capacity, never counts
# =====================================================================================


def test_frozen_p4_books_capacity_and_never_counts() -> None:
    frozen = base_project(
        project_id="f4", priority="P4", frozen=True, actual_start_week=SELFTEST_WEEK
    )
    p1 = base_project(project_id="p1", priority="P1")
    si = _si(frozen, p1)
    for out in (run_greedy_sgs(si), run_cp_sat(si, **CP_KW)[0]):
        b = _by(out)
        f = b["f4"]
        assert not f.excluded and not f.not_scheduled_priority and not f.counts_toward_year
        assert not f.within_year and not f.spillover and f.projected_end_week is not None
        assert _step(f, "PDD-A").start_week == SELFTEST_WEEK
        # Its locked design weeks are booked: the P1 project waits for eng-a.
        assert _step(b["p1"], "PDD-A").start_week > _step(f, "PDD-A").end_week
        assert out.scheduling_order[0] == "f4"
        assert validate_invariants(si, out, check_determinism=False) == ()


# =====================================================================================
# R42-5 / I51 / I52: queued P3 takes spare capacity only
# =====================================================================================


def _queued_fixture() -> ScheduleInput:
    # A VIP queued P3 on eng-a and the chamber, and a non-VIP P1 on the same
    # resources: the P1 books first (key 1a above VIP, OQ #110).
    vip_q = base_project(project_id="a-vipq", priority="P3", is_vip=True)
    p1 = base_project(project_id="z-p1", priority="P1")
    p2 = base_project(project_id="m-p2", priority="P2", leader_engineer_id="eng-b")
    return _si(vip_q, p1, p2)


def test_vip_queued_p3_walks_after_counting_work() -> None:
    si = _queued_fixture()
    out = run_greedy_sgs(si)
    assert out.scheduling_order == ("z-p1", "m-p2", "a-vipq")
    b = _by(out)
    q = b["a-vipq"]
    # P53 (R53-2): a queued P3 still walks last (queue tier) but now counts.
    assert q.counts_toward_year and q.within_year and not q.spillover
    assert q.projected_end_week is not None and q.projected_end_week <= 52
    assert classify_outcome(q) == "within_year"
    assert _step(b["z-p1"], "PDD-A").start_week == SELFTEST_WEEK
    assert _step(q, "PDD-A").start_week > _step(b["z-p1"], "PDD-A").end_week
    assert validate_invariants(si, out) == ()


@pytest.mark.parametrize("solver", ["greedy", "cp_sat"])
def test_band_neutrality_holds_on_both_solvers(solver: str) -> None:
    si = _queued_fixture()
    params = CP_KW if solver == "cp_sat" else {}
    assert check_band_neutrality(si, solver, **params) == ()
    # And on the seed (8 queued P3, 25 P4 / Q, none started).
    seed = load_seed_schedule_input()
    assert check_band_neutrality(seed, solver, **params) == ()


def test_cp_sat_parity_on_i49_to_i52_on_the_seed() -> None:
    seed = load_seed_schedule_input()
    g = run_greedy_sgs(seed)
    c, info = run_cp_sat(seed, deterministic_time=3.0, earliness_deterministic_time=1.0)
    assert info.num_queued_walked == 8
    assert validate_invariants(seed, g) == ()
    assert validate_invariants(seed, c, check_determinism=False) == ()
    gb, cb = _by(g), _by(c)
    for pid in sorted(gb):
        assert gb[pid].counts_toward_year == cb[pid].counts_toward_year, pid
        assert gb[pid].not_scheduled_priority == cb[pid].not_scheduled_priority, pid
    assert g.scheduling_order == c.scheduling_order
    assert sum(o.not_scheduled_priority for o in g.project_outcomes) == 25
    # P53 (R53-2): the 8 queued P3 now count; only the 25 P4 / Q do not.
    assert sum(not o.counts_toward_year for o in g.project_outcomes) == 25
    assert sum(project_queue_tier(p) for p in seed.projects) == 33


def test_cp_sat_model_ignores_queued_projects() -> None:
    si = _queued_fixture()
    full, info = run_cp_sat(si, **CP_KW)
    reduced, info_r = run_cp_sat(without_spare_capacity_projects(si), **CP_KW)
    assert info.num_solvable_projects == info_r.num_solvable_projects == 2
    assert (info.num_queued_walked, info_r.num_queued_walked) == (1, 0)
    assert info.objective_value == info_r.objective_value
    fb = _by(full)
    for o in reduced.project_outcomes:
        assert fb[o.project_id] == o


# =====================================================================================
# Validator negatives: I49, I50, I51, I52
# =====================================================================================


def _codes(viol) -> set[str]:
    return {v.invariant for v in viol}


def test_i49_flags_a_scheduled_p4_and_a_stray_flag() -> None:
    p4 = base_project(project_id="p4", priority="P4")
    p1 = base_project(project_id="p1", priority="P1")
    si = _si(p4, p1)
    out = run_greedy_sgs(si)
    b = _by(out)
    forged = dataclasses.replace(
        out,
        project_outcomes=(
            dataclasses.replace(b["p1"], not_scheduled_priority=True),
            dataclasses.replace(b["p4"], excluded=False, not_scheduled_priority=False),
        ),
        scheduling_order=("p1", "p4"),
    )
    viol = validate_invariants(si, forged, check_determinism=False)
    i49 = [v for v in viol if v.invariant == "I49"]
    assert {v.project_id for v in i49} == {"p1", "p4"}


def test_i50_flags_a_wrong_counts_flag_and_a_counted_queued_project() -> None:
    # P53 (R53-2): a queued P3 counts; a frozen P4 is the non-counting case.
    q = base_project(project_id="q", priority="P3")
    si = _si(q)
    out = run_greedy_sgs(si)
    o = _by(out)["q"]
    assert o.counts_toward_year
    viol = validate_invariants(
        si,
        dataclasses.replace(
            out, project_outcomes=(dataclasses.replace(o, counts_toward_year=False),)
        ),
        check_determinism=False,
    )
    assert "I50" in _codes(viol)
    f4 = base_project(project_id="q", priority="P4", frozen=True, actual_start_week=SELFTEST_WEEK)
    si = _si(f4)
    out = run_greedy_sgs(si)
    o = _by(out)["q"]
    assert not o.counts_toward_year
    for bad in (
        dataclasses.replace(o, counts_toward_year=True),
        dataclasses.replace(o, within_year=True),
    ):
        viol = validate_invariants(
            si, dataclasses.replace(out, project_outcomes=(bad,)), check_determinism=False
        )
        assert "I50" in _codes(viol)


def test_i51_flags_a_queued_project_before_a_counting_one() -> None:
    si = _queued_fixture()
    out = run_greedy_sgs(si)
    forged = dataclasses.replace(out, scheduling_order=("a-vipq", "z-p1", "m-p2"))
    assert "I51" in _codes(validate_invariants(si, forged, check_determinism=False))


def test_i52_flags_a_solver_that_lets_queued_work_take_capacity(monkeypatch) -> None:
    si = _queued_fixture()
    real = inv.run_greedy_sgs

    def leaky(x: ScheduleInput):
        out = real(x)
        if any(p.project_id == "a-vipq" for p in x.projects):
            out = dataclasses.replace(
                out,
                project_outcomes=tuple(
                    dataclasses.replace(o, end_week=(o.end_week or 0) + 1)
                    if o.project_id == "z-p1"
                    else o
                    for o in out.project_outcomes
                ),
            )
        return out

    monkeypatch.setattr(inv, "run_greedy_sgs", leaky)
    viol = check_band_neutrality(si)
    assert [(v.invariant, v.project_id) for v in viol] == [("I52", "z-p1")]


def test_i52_premise_skips_a_started_queued_project() -> None:
    started = (
        progress("PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=21),
    )
    q = base_project(project_id="q", priority="P3", step_progress=started)
    assert check_band_neutrality(_si(q, base_project(project_id="p1"))) == ()


# =====================================================================================
# What-if, plan import, Monte Carlo, demand
# =====================================================================================


def test_whatif_classes_and_queued_new_project_target() -> None:
    base = tiny_baseline(engineers=1)
    res = simulate(
        base,
        Scenario(
            add_projects=(
                AddProject("R&D-Greece", "C"),  # default P3 In Queue: counts (R53-2)
                AddProject("R&D-Greece", "C", priority="P4"),
            )
        ),
    )
    new = {p.project_id: p for p in res.projects if p.is_new}
    outcomes = sorted(p.outcome for p in new.values())
    assert outcomes == ["not_scheduled_priority", "within_year"]
    assert res.outcome_counts_after["queued"] == 0
    assert res.outcome_counts_after["not_scheduled_priority"] == 1
    q3 = next(p for p in new.values() if p.outcome == "within_year")
    assert q3.counts_toward_year and q3.within_year
    assert q3.finish_week is not None and q3.finish_week <= 52


def test_plan_import_kpis_serve_queued_and_not_scheduled() -> None:
    base = tiny_baseline(engineers=1)

    def row(n: int, prio: str) -> ImportProject:
        return ImportProject(
            key=f"r{n}",
            name=f"I{n}",
            hub="R&D-Greece",
            category="C",
            status="In Queue",
            priority=prio,
            rank=None,
            file_row=n,
            leader=None,
            current_step_id=None,
            step_weeks=(),
        )

    res = run_plan_import(
        base,
        PlanImportRequest(projects=(row(1, "P2"), row(2, "P3"), row(3, "Q")), mode="file_only"),
    )
    k = res.kpis
    # P53 (R53-2): the In Queue P3 row counts (walked after the P2).
    assert (k.queued, k.not_scheduled_priority, k.within_plan_year) == (0, 1, 2)
    rows = {r.ref: r for r in res.projects}
    assert rows["r3"].not_scheduled_priority and rows["r3"].outcome == "not_scheduled_priority"
    assert not rows["r3"].leader_auto_assigned  # never scheduled, never auto-led
    assert rows["r2"].counts_toward_year and rows["r2"].outcome == "within_year"
    codes = {(i.ref, i.code) for i in res.issues}
    assert ("r3", "NOT_SCHEDULED_PRIORITY") in codes and ("r2", "QUEUED") not in codes


def test_monte_carlo_carries_the_band_flags() -> None:
    si = _si(
        base_project(project_id="p1"),
        base_project(project_id="q", priority="P3"),
        base_project(project_id="p4", priority="P4"),
    )
    fc = {f.project_id: f for f in forecast_delivery(si, iterations=4, seed=3).project_forecasts}
    assert fc["p4"].not_scheduled_priority and fc["p4"].iterations_scheduled == 0
    # P53 (R53-2): a queued P3 counts.
    assert fc["q"].counts_toward_year and fc["q"].iterations_within_year == 4
    assert fc["p1"].counts_toward_year and fc["p1"].iterations_within_year == 4


def _live(pid: str, *, priority: str | None, frozen: bool = False) -> LiveProjectRow:
    steps = (
        LiveStepRow("PDD-A", 1, "design", 4, None, None),
        LiveStepRow("PDD-F", 2, "lab", 3, None, None),
    )
    return LiveProjectRow(
        project_id=pid,
        hub="R&D-Greece",
        capacity_hub="R&D-Greece",
        status="In Queue",
        frozen=frozen,
        certification_testing_required=True,
        design_effort_weeks=None,
        lab_effort_weeks=None,
        steps=steps,
        priority=priority,
    )


def test_i25_remaining_demand_drops_non_frozen_p4_and_q_only() -> None:
    rows = [
        _live("p1", priority="P1"),
        _live("q3", priority="P3"),  # queued: still scheduled, still in demand
        _live("p4", priority="P4"),
        _live("qq", priority="Q"),
        _live("f4", priority="P4", frozen=True),
    ]
    d = compute_demand_load(rows)
    assert d.design_full_year["R&D-Greece"] == 20
    assert d.design_remaining["R&D-Greece"] == 12
    assert d.lab_remaining["Greece"] == 9.0
    # The default (no priority given) keeps the pre-P42 figure.
    legacy = compute_demand_load([dataclasses.replace(r, priority=None) for r in rows])
    assert legacy.design_remaining["R&D-Greece"] == 20


# =====================================================================================
# No queued / P4 / Q in the input: byte-identical to pre-P42
# =====================================================================================

#: sha256 over sorted-key JSON, P42 default fields stripped (`_strip`), measured on
#: HEAD before P42-T02 and after: identical. Inputs: the seed and
#: `portfolio_baseline()` with every P4 / Q and every In Queue P3 moved to P2,
#: and added / imported projects at P2.
# P53-T02 (ADR 0063) re-pin: values recomputed under the P53 rules. Every
# changed field was attributed by an old/new differential (MEMORY P53-T02):
# (a) a project LEFT_OUT at the 78-week search now placed within H = cw + 260
# (portfolio p017 / p024; seed 26-00205 ...), (c) a queued P3 now counted
# (R53-2: p003 / p009 / p023, import rows "In Queue" P3), and for plan import
# R53-4 (`horizon_weeks` = H not u + 26; the QUEUED issue no longer raised).
_PRE_P42_NEUTRAL = {
    "analytic_add_remaining": "75937da190f468418224473635808125b0a1ffaccb20d9e91ff5945f9cc4b880",
    "analytic_add_year": "f9163d6349c18fb9cf0a012774e2d36eb4d4e04bb78158409caa685d3cdbb66f",
    "analytic_remove_remaining": "4f24761a6e50728a520602e2178a211fd13c7d81f8bf17422a4db7d593baf011",
    "analytic_remove_year": "69e13f8a40247245e03d69aed360c89495b47b42ace0b29f5893eabfc23c17c2",
    "plan_import_104": "87e93dcdc6aef77e719166980faa46692aa8e9ee36b33a72fb7e835c239122d8",
    "plan_import_52": "f34d808aabf7e2ff080a4c6178afefe1f18b8c3a972aaca25fe00821e6d92a1a",
    "seed_cp_sat": "5bc74bc3ea4a2c06eb9fcf2a2ec2569333b66f8ee75b825ad99810cb61856de3",
    "seed_greedy": "94d7f3b35ac534be735686b49dbcb77c93a724f01a86d370994df41d8b4d9a2b",
    "seed_mc": "c47d73ee8769ef777aa62156b9f391f9265630d34f920f41e3344f521cb838d7",
    "simulate_add": "c838f4ea5a4ba9a10d504bcd449241c876166950a141014ef9eabd88d542bffc",
    "simulate_remove": "c1225d29afdc0a22e6376b2a82919b45372e4fb924250ff4477a50d911ee28cb",
}

_P42_DEFAULTS = {
    "not_scheduled_priority": (False, 0),
    "counts_toward_year": (True,),
    "queued": (0,),
}


def _strip(x):
    if isinstance(x, dict):
        return {
            k: _strip(v)
            for k, v in x.items()
            if not (k in _P42_DEFAULTS and v in _P42_DEFAULTS[k] and type(v) is not float)
        }
    if isinstance(x, list):
        return [_strip(v) for v in x]
    return x


def _h(x) -> str:
    return hashlib.sha256(json.dumps(_strip(x), sort_keys=True, default=str).encode()).hexdigest()


def _without_r49_fields(res: PlanImportResult, pyew: int) -> object:
    """P49 (ADR 0061, I54 / I56): the result gained `plan_from_week` and
    `plan_until_week`; unset they are (current_week, plan_year_end_week) and
    the rest of the response is unchanged, so the pre-R49 hash still holds."""

    d = to_jsonable(res)
    assert isinstance(d, dict)
    assert d.pop("plan_from_week") == res.current_week
    assert d.pop("plan_until_week") == pyew
    return d


def _neutral(p: ProjectInput) -> ProjectInput:
    if p.status in dc.SCHEDULABLE_STATUS_ORDER and not dc.counts_toward_year(p.priority, p.status):
        return dataclasses.replace(p, priority="P2")
    return p


def _neutral_si(si: ScheduleInput) -> ScheduleInput:
    return dataclasses.replace(si, projects=tuple(_neutral(p) for p in si.projects))


def test_neutral_inputs_are_byte_identical_to_pre_p42() -> None:
    got: dict[str, str] = {}
    seed = _neutral_si(load_seed_schedule_input())
    assert all(dc.counts_toward_year(p.priority, p.status) for p in seed.projects)
    g = run_greedy_sgs(seed)
    # The canonical (hashed / stored) form needs no stripping at all.
    assert all(
        "counts_toward_year" not in o and "not_scheduled_priority" not in o
        for o in canonical_schedule_output_asdict(g)["project_outcomes"]
    )
    got["seed_greedy"] = _h(canonical_schedule_output_asdict(g))
    cp, _ = run_cp_sat(seed, deterministic_time=3.0, earliness_deterministic_time=1.0)
    got["seed_cp_sat"] = _h(canonical_schedule_output_asdict(cp))
    got["seed_mc"] = _h(to_jsonable(forecast_delivery(seed, iterations=8, seed=11)))

    b = portfolio_baseline()
    b = dataclasses.replace(b, schedule=_neutral_si(b.schedule))
    scens = {
        "add": Scenario(add_projects=(AddProject("PD-Romania", "B", count=3, priority="P2"),)),
        "remove": Scenario(
            remove_engineer_counts=(RemoveEngineerCount("PD-Romania", 1),),
            add_engineers=(AddEngineer("R&D-India", 0.5),),
        ),
    }
    for k, sc in scens.items():
        for basis in ("year", "remaining"):
            got[f"analytic_{k}_{basis}"] = _h(
                to_jsonable(analytic_requirements(b, sc, basis=basis))
            )
        got[f"simulate_{k}"] = _h(without_p53_r01_fields(simulate(b, sc)))
    rows = tuple(
        ImportProject(
            key=f"r{i}",
            name=f"I{i}",
            hub=hub,
            category=cat,
            status="In Queue",
            priority="P2",
            rank=None,
            file_row=i + 1,
            leader=None,
            current_step_id=None,
            step_weeks=(),
        )
        for i, (hub, cat) in enumerate(
            [("PD-Romania", "B"), ("R&D-Greece", "A"), ("PD-India", "C"), ("OEM-HCK", "B-OEM")]
        )
    )
    for y in (52, 104):
        got[f"plan_import_{y}"] = _h(
            _without_r49_fields(
                run_plan_import(b, PlanImportRequest(projects=rows, plan_year_end_week=y)), y
            )
        )
    assert got == _PRE_P42_NEUTRAL


def test_sort_key_1a_is_constant_without_non_counting_projects() -> None:
    projects = [
        base_project(project_id="a", priority="P2", status="In Development"),
        base_project(project_id="b", priority="P1", is_vip=True),
        base_project(project_id="c", priority="P3", status="In Buyoff"),
    ]
    assert {_sort_key(p)[1] for p in projects} == {0}
