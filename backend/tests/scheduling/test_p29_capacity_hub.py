"""P29-T02 golden files: ADR 0042 capacity hubs (OEM hubs under Greece capacity).

`ProjectInput.capacity_hub` (defaults to `hub`) is the project's engineer pool
and the hub its design load counts against. OEM-HCK / OEM-Seitek projects carry
`capacity_hub="R&D-Greece"` and are designed by R&D-Greece engineers. The
workflow (OEM) and the lab region (Greece) still follow `project.hub`.

The greedy / CP-SAT walks book the *assigned* leader and never pick one, so
the pool rule shows up in engineer *selection* (the what-if picker) and in the
capacity-hub load aggregate. A leaderless project stays `LEFT_OUT` /
`no_leader` (never auto-assigned): ADR 0042 section 7 has the seed assign
provisional leaders.

Every expected week is hand-derived from `docs/DOMAIN_RULES.md` "Lead times"
with CURRENT_WEEK 31 (set explicitly on every input):

    PDD   / B     : 1 0 0 1 4 0 0 6 0 1 2 1 1 1   (design A D E J K M; lab H)
    OEM   / B-OEM : 1 1 1 0 0 2 2 6 0 1 0 0 0 0   (design A B G J;     lab H)

Every scheduler test asserts the documented outcome AND `validate_invariants == ()`.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from scheduling import (
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    check_scheduler_determinism,
    compute_design_load_by_capacity_hub,
    compute_design_load_by_hub,
    cross_capacity_hub_leaders,
    run_cp_sat,
    run_greedy_sgs,
    validate_invariants,
)
from scheduling._selftest_common import load_seed_schedule_input
from scheduling.whatif import (
    AddProject,
    HubCalendarInput,
    RemoveEngineerCount,
    Scenario,
    WhatIfBaseline,
    analytic_requirements,
    apply_scenario,
    simulate,
    solve_minimum_additions,
    touched_scope,
)

CW = 31
GREEK_CATS = ("A+", "A", "B", "C", "A-OEM", "B-OEM", "C-OEM")

# ADR 0042 section 6: Greek roster engineers gain A-OEM/B-OEM/C-OEM. `ENG_GR_B`
# carries B-OEM only (no generic "OEM" marker): the X-OEM eligibility branch.
ENG_GR = EngineerInput("eng-gr", "Greek A", "R&D-Greece", GREEK_CATS)
ENG_GR_B = EngineerInput("eng-gr-b", "Greek B", "R&D-Greece", ("A+", "A", "B", "C", "B-OEM"))
# A legacy OEM-HCK engineer (ADR 0042: child hubs carry no engineers; kept
# here only to prove the pool is the capacity hub, not the project's hub).
ENG_HCK = EngineerInput("eng-hck", "Legacy HCK", "OEM-HCK", ("OEM", "A-OEM", "B-OEM", "C-OEM"))

OEM_LAB = ("OEM-E", "OEM-H")
PDD_LAB = ("PDD-F", "PDD-H")
# `ch-a-india` sorts first and hosts every lab stage, but is in the wrong region.
CH_INDIA = ChamberInput("ch-a-india", "IN", "India", 1, PDD_LAB + OEM_LAB)
CH_GREECE = ChamberInput("ch-gr", "GR", "Greece", 1, PDD_LAB + OEM_LAB)


def _oem(pid: str = "p-oem", **kw: object) -> ProjectInput:
    base: dict[str, object] = dict(
        project_id=pid,
        name=pid,
        hub="OEM-HCK",
        status="In Queue",
        category="B-OEM",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-gr-b",
        workflow_id="OEM",
        capacity_hub="R&D-Greece",
    )
    base.update(kw)
    return ProjectInput(**base)  # type: ignore[arg-type]


def _greek(pid: str = "p-gr", **kw: object) -> ProjectInput:
    base: dict[str, object] = dict(
        project_id=pid,
        name=pid,
        hub="R&D-Greece",
        status="In Queue",
        category="B",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-gr-b",
    )
    base.update(kw)
    return ProjectInput(**base)  # type: ignore[arg-type]


def _si(
    *projects: ProjectInput, engineers: tuple[EngineerInput, ...] = (ENG_GR_B,)
) -> ScheduleInput:
    return ScheduleInput(
        projects=projects,
        engineers=engineers,
        chambers=(CH_INDIA, CH_GREECE),
        current_week=CW,
    )


def _by_id(out: ScheduleOutput) -> dict[str, ProjectScheduleOutcome]:
    return {o.project_id: o for o in out.project_outcomes}


def _rows(outcome: ProjectScheduleOutcome, kind: str) -> list[tuple[str, int, int, str | None]]:
    return [
        (
            s.step_id,
            s.start_week,
            s.end_week,
            s.assigned_engineer_id if kind == "design" else s.assigned_chamber_id,
        )
        for s in outcome.steps
        if s.kind == kind and not s.skipped
    ]


# --- The field --------------------------------------------------------------------


def test_capacity_hub_defaults_to_hub_and_keeps_an_explicit_value() -> None:
    plain = _greek()
    assert plain.capacity_hub == "R&D-Greece"
    bare = ProjectInput("x", "x", "OEM-HCK", "In Queue", "B-OEM", "P1", False, None)
    assert bare.capacity_hub == "OEM-HCK"
    assert _oem().capacity_hub == "R&D-Greece"
    # Documented gotcha: `replace(hub=...)` re-passes the resolved capacity hub.
    assert replace(plain, hub="PD-India").capacity_hub == "R&D-Greece"
    assert replace(plain, hub="PD-India", capacity_hub="PD-India").capacity_hub == "PD-India"


def test_unknown_capacity_hub_is_a_configuration_error() -> None:
    with pytest.raises(ValueError, match="capacity_hub"):
        run_greedy_sgs(_si(_oem(capacity_hub="Atlantis")))


# --- Golden: OEM project on the Greece capacity hub ---------------------------------


@pytest.mark.parametrize("solver", ["greedy", "cp_sat"])
def test_oem_project_designed_by_greek_engineer_in_greece_lab_region(solver: str) -> None:
    """B-OEM, CW 31: A 31, B 32, C 33, (D, E skipped), F 34-35, G 36-37,
    H 38-43, (I skipped), J 44, (K-N skipped). End W44, within year."""

    si = _si(_oem())
    out = run_greedy_sgs(si) if solver == "greedy" else run_cp_sat(si)[0]
    o = _by_id(out)["p-oem"]

    assert not o.left_out and not o.no_leader and not o.excluded
    assert not o.cat_not_allowed
    assert not o.eng_conflict and not o.overlap
    assert [s.step_id for s in o.steps] == [f"OEM-{c}" for c in "ABCDEFGHIJKLMN"]
    assert _rows(o, "design") == [
        ("OEM-A", 31, 31, "eng-gr-b"),
        ("OEM-B", 32, 32, "eng-gr-b"),
        ("OEM-G", 36, 37, "eng-gr-b"),
        ("OEM-J", 44, 44, "eng-gr-b"),
    ]
    assert _rows(o, "lab") == [("OEM-H", 38, 43, "ch-gr")]
    assert o.end_week == 44 and o.within_year and not o.spillover
    assert validate_invariants(si, out) == ()


def test_greek_engineer_is_one_calendar_across_greek_and_oem_projects() -> None:
    """The shared pool in action: the P1 Greek project books eng-gr-b first
    (A 31, D 32, E 33-36, H 37-42, J 43, K 44-45, L 46, M 47, N 48); the P2
    OEM project waits for every busy week of that same engineer:
    A 37, B 38, C 39, F 40-41, G 48-49 (42-47 blocked by J/K/M), H 50-55, J 56."""

    si = _si(_greek(), _oem(priority="P2"))
    out = run_greedy_sgs(si)
    by = _by_id(out)
    assert out.scheduling_order == ("p-gr", "p-oem")
    assert _rows(by["p-gr"], "design") == [
        ("PDD-A", 31, 31, "eng-gr-b"),
        ("PDD-D", 32, 32, "eng-gr-b"),
        ("PDD-E", 33, 36, "eng-gr-b"),
        ("PDD-J", 43, 43, "eng-gr-b"),
        ("PDD-K", 44, 45, "eng-gr-b"),
        ("PDD-M", 47, 47, "eng-gr-b"),
    ]
    assert _rows(by["p-oem"], "design") == [
        ("OEM-A", 37, 37, "eng-gr-b"),
        ("OEM-B", 38, 38, "eng-gr-b"),
        ("OEM-G", 48, 49, "eng-gr-b"),
        ("OEM-J", 56, 56, "eng-gr-b"),
    ]
    assert _rows(by["p-oem"], "lab") == [("OEM-H", 50, 55, "ch-gr")]
    oem = by["p-oem"]
    assert oem.spillover and not oem.within_year and not oem.left_out
    assert not any(o.eng_conflict for o in out.project_outcomes)
    assert validate_invariants(si, out) == ()


# --- Determinism and regression -----------------------------------------------------


def test_determinism_i8_with_capacity_hub() -> None:
    si = _si(_greek(), _oem(priority="P2"), _oem("p-oem-2", hub="OEM-Seitek", priority="P3"))
    assert repr(run_greedy_sgs(si)) == repr(run_greedy_sgs(si))
    assert check_scheduler_determinism(si) == ()
    shuffled = replace(si, projects=tuple(reversed(si.projects)))
    assert run_greedy_sgs(shuffled) == run_greedy_sgs(si)


def test_unset_capacity_hub_is_byte_identical_on_the_fixture() -> None:
    with_cap = _si(_greek(), _oem(priority="P2"))
    without = _si(
        _greek(),
        replace(_oem(priority="P2"), capacity_hub="OEM-HCK"),  # == the default for hub OEM-HCK
    )
    assert repr(run_greedy_sgs(with_cap)) == repr(run_greedy_sgs(without))
    assert repr(run_cp_sat(with_cap)[0]) == repr(run_cp_sat(without)[0])


def test_seed_byte_identical_with_and_without_capacity_hub() -> None:
    """The 46-project seed maps OEM projects to capacity hub R&D-Greece
    (`load_seed_schedule_input`); resetting every capacity hub to the hub must
    not move a single byte of greedy or CP-SAT output."""

    si = load_seed_schedule_input()
    assert {p.capacity_hub for p in si.projects if p.hub.startswith("OEM")} == {"R&D-Greece"}
    plain = replace(si, projects=tuple(replace(p, capacity_hub=p.hub) for p in si.projects))
    g = run_greedy_sgs(si)
    assert repr(g) == repr(run_greedy_sgs(plain))
    assert repr(run_cp_sat(si)[0]) == repr(run_cp_sat(plain)[0])
    assert validate_invariants(si, g) == ()


# --- Leaderless projects (unchanged: LEFT_OUT, never auto-assigned) -----------------


@pytest.mark.parametrize("solver", ["greedy", "cp_sat"])
@pytest.mark.parametrize("leader", [None, "ghost"])
def test_leaderless_oem_project_is_left_out_not_auto_assigned(
    solver: str, leader: str | None
) -> None:
    """An eligible, idle Greek engineer exists in the capacity hub; the
    project is still LEFT_OUT with no_leader, books nothing, and the Greek
    project behind it starts at CURRENT_WEEK."""

    si = _si(_oem(leader_engineer_id=leader), _greek(priority="P2"))
    out = run_greedy_sgs(si) if solver == "greedy" else run_cp_sat(si)[0]
    by = _by_id(out)
    o = by["p-oem"]
    assert o.left_out and o.no_leader
    assert o.steps == () and o.start_week is None and o.end_week is None
    assert not o.within_year and not o.spillover and not o.cat_not_allowed
    assert o.projected_end_week is None
    assert o.unconstrained_end_week == 44
    assert _rows(by["p-gr"], "design")[0] == ("PDD-A", 31, 31, "eng-gr-b")
    assert validate_invariants(si, out) == ()


# --- Aggregates and the cross-hub diagnostic ----------------------------------------


def test_design_load_by_capacity_hub_puts_oem_load_on_greece() -> None:
    si = _si(_greek(), _oem(priority="P2"), _oem("p-sel", hub="OEM-Seitek", priority="P3"))
    out = run_greedy_sgs(si)
    # PDD/B design 1+1+4+1+2+1 = 10; OEM/B-OEM design 1+1+2+1 = 5 each.
    assert compute_design_load_by_hub(si, out) == {
        "R&D-Greece": 10,
        "OEM-HCK": 5,
        "OEM-Seitek": 5,
    }
    assert compute_design_load_by_capacity_hub(si, out) == {"R&D-Greece": 20}
    assert validate_invariants(si, out) == ()


def test_cross_capacity_hub_leaders_is_a_diagnostic_not_a_violation() -> None:
    si = _si(
        _oem(),  # Greek leader: inside the capacity hub
        _oem("p-legacy", leader_engineer_id="eng-hck", priority="P2"),  # pre-P29 OEM leader
        _greek("p-noleader", leader_engineer_id=None),
        engineers=(ENG_GR_B, ENG_HCK),
    )
    rows = cross_capacity_hub_leaders(si)
    assert [(r.project_id, r.capacity_hub, r.engineer_id, r.engineer_hub) for r in rows] == [
        ("p-legacy", "R&D-Greece", "eng-hck", "OEM-HCK")
    ]
    # The scheduler books the assigned leader regardless (Booking rules), and
    # the validator does not reject it: client data has cross-hub leaders.
    out = run_greedy_sgs(si)
    legacy = _by_id(out)["p-legacy"]
    assert {eng for _sid, _s, _e, eng in _rows(legacy, "design")} == {"eng-hck"}
    assert validate_invariants(si, out) == ()


# --- What-if: engineer selection uses the capacity hub ------------------------------


def _whatif_baseline() -> WhatIfBaseline:
    si = ScheduleInput(
        projects=(
            _greek(leader_engineer_id="eng-gr"),
            _oem("p-oem-base", leader_engineer_id="eng-gr", priority="P2"),
        ),
        engineers=(ENG_GR, ENG_GR_B, ENG_HCK),
        chambers=(CH_INDIA, CH_GREECE),
        current_week=CW,
    )
    return WhatIfBaseline(schedule=si, calendars=(HubCalendarInput("R&D-Greece", 5, 10, 0, 0, 0),))


def test_whatif_new_oem_project_is_led_from_the_capacity_hub() -> None:
    """The idle legacy OEM-HCK engineer would win under the old `hub` pool; the
    pool is now R&D-Greece, whose least-loaded eligible engineer is eng-gr-b."""

    base = _whatif_baseline()
    applied = apply_scenario(base, Scenario(add_projects=(AddProject("OEM-HCK", "B-OEM"),)))
    (pid,) = applied.new_project_ids
    new = next(p for p in applied.schedule_input.projects if p.project_id == pid)
    assert (new.hub, new.capacity_hub, new.workflow_id) == ("OEM-HCK", "R&D-Greece", "OEM")
    assert new.leader_engineer_id == "eng-gr-b"
    out = run_greedy_sgs(applied.schedule_input)
    assert validate_invariants(applied.schedule_input, out) == ()

    # An explicit capacity hub overrides the baseline's.
    explicit = apply_scenario(
        base, Scenario(add_projects=(AddProject("OEM-HCK", "B-OEM", capacity_hub="OEM-HCK"),))
    )
    (pid2,) = explicit.new_project_ids
    new2 = next(p for p in explicit.schedule_input.projects if p.project_id == pid2)
    assert new2.leader_engineer_id == "eng-hck"


def test_whatif_design_figures_are_per_capacity_hub() -> None:
    base = _whatif_baseline()
    sc = Scenario(add_projects=(AddProject("OEM-HCK", "B-OEM"),))
    assert touched_scope(base, sc) == (("R&D-Greece",), ("Greece",))
    req = analytic_requirements(base, sc)
    rows = {r.hub: r for r in req.design}
    assert rows["R&D-Greece"].added_projects == 1
    assert rows["R&D-Greece"].extra_design_weeks == 5
    # Baseline load on Greece's row includes the existing OEM project (10 + 5).
    assert rows["R&D-Greece"].baseline_load_weeks == 15.0
    assert "OEM-HCK" not in rows or rows["OEM-HCK"].added_projects == 0
    assert req.extra_design_weeks_total == 5
    assert any("1 x 5 wk (B-OEM, OEM-HCK)" in w for w in req.workings)
    r = solve_minimum_additions(base, sc, "all_new_within_year")
    assert r.searched_designer_hubs == ("R&D-Greece",)


def test_whatif_unknown_capacity_hub_rejected() -> None:
    with pytest.raises(ValueError, match="capacity hub"):
        apply_scenario(
            _whatif_baseline(),
            Scenario(add_projects=(AddProject("OEM-HCK", "B-OEM", capacity_hub="Atlantis"),)),
        )


# --- P29-T05: counted designers (`EngineerInput.counts_in_capacity`) ----------------
#
# Baseline: capacity hub R&D-Greece, calendar 5 d/wk with 10 holiday days, so
# working weeks per engineer = 52 - 10/5 = 50.
#   eng-gr        counted, leads p-gr       (PDD/B  design 1+1+4+1+2+1 = 10)
#   eng-gr-b      counted, leads p-gr-2     (PDD/A+ design 1+8+1+6+2+1+2+1 = 22)
#   eng-a-theoni  NOT counted (OQ #52), leads p-oem-base (OEM/B-OEM design 5);
#                 sorts first and is the least loaded, so it is exactly the
#                 engineer the picker would choose if it were counted.

THEONI = EngineerInput("eng-a-theoni", "Theoni", "R&D-Greece", GREEK_CATS, counts_in_capacity=False)


def _counted_baseline(theoni_counts: bool = False) -> WhatIfBaseline:
    si = ScheduleInput(
        projects=(
            _greek("p-gr", leader_engineer_id="eng-gr"),
            _greek("p-gr-2", leader_engineer_id="eng-gr-b", category="A+", priority="P2"),
            _oem("p-oem-base", leader_engineer_id="eng-a-theoni", priority="P3"),
        ),
        engineers=(ENG_GR, ENG_GR_B, replace(THEONI, counts_in_capacity=theoni_counts)),
        chambers=(CH_INDIA, CH_GREECE),
        current_week=CW,
    )
    return WhatIfBaseline(schedule=si, calendars=(HubCalendarInput("R&D-Greece", 5, 10, 0, 0, 0),))


def _leader_of(applied_si: ScheduleInput, pid: str) -> str | None:
    return next(p.leader_engineer_id for p in applied_si.projects if p.project_id == pid)


def test_counts_in_capacity_defaults_true_and_never_changes_booking() -> None:
    assert ENG_GR.counts_in_capacity is True
    counted = _si(_greek(), _oem(priority="P2"))
    flagged = replace(counted, engineers=(replace(ENG_GR_B, counts_in_capacity=False),))
    # Greedy / CP-SAT book the assigned leader whatever the flag (Booking rules).
    assert repr(run_greedy_sgs(flagged)) == repr(run_greedy_sgs(counted))
    assert repr(run_cp_sat(flagged)[0]) == repr(run_cp_sat(counted)[0])
    out = run_greedy_sgs(flagged)
    assert {eng for _sid, _s, _e, eng in _rows(_by_id(out)["p-oem"], "design")} == {"eng-gr-b"}
    assert validate_invariants(flagged, out) == ()


def test_whatif_supply_sums_counted_engineers_only() -> None:
    req = analytic_requirements(_counted_baseline(), Scenario())
    gr = {r.hub: r for r in req.design}["R&D-Greece"]
    assert (gr.fte_before, gr.fte_after_scenario) == (2.0, 2.0)
    assert gr.capacity_before == 100.0  # 50 wk x 2 counted FTE
    assert gr.baseline_load_weeks == 37.0  # 10 + 22 + 5: Theoni's project is still load
    assert gr.booked_pct_before == 37.0
    # The same engineer counted adds 50 wk of supply.
    gr_all = {r.hub: r for r in analytic_requirements(_counted_baseline(True), Scenario()).design}
    assert (gr_all["R&D-Greece"].fte_before, gr_all["R&D-Greece"].capacity_before) == (3.0, 150.0)

    util = {u.key: u for u in simulate(_counted_baseline(), Scenario()).utilization_before}
    assert util["R&D-Greece"].units == 2.0
    assert util["R&D-Greece"].capacity_year == 100.0


def test_whatif_non_counted_leader_keeps_projects_but_is_never_picked() -> None:
    sc = Scenario(add_projects=(AddProject("OEM-HCK", "B-OEM"),))
    applied = apply_scenario(_counted_baseline(), sc)
    (pid,) = applied.new_project_ids
    # Least-loaded counted designer: eng-gr (10) over eng-gr-b (22); Theoni (5) is skipped.
    assert _leader_of(applied.schedule_input, pid) == "eng-gr"
    assert _leader_of(apply_scenario(_counted_baseline(True), sc).schedule_input, pid) == (
        "eng-a-theoni"
    )
    # Theoni keeps her project and is booked for it.
    assert _leader_of(applied.schedule_input, "p-oem-base") == "eng-a-theoni"
    out = run_greedy_sgs(applied.schedule_input)
    theoni_rows = _rows(_by_id(out)["p-oem-base"], "design")
    assert theoni_rows and {eng for *_x, eng in theoni_rows} == {"eng-a-theoni"}
    assert validate_invariants(applied.schedule_input, out) == ()


def test_whatif_reassignment_skips_non_counted_engineers() -> None:
    sc = Scenario(remove_engineers=("eng-gr",))
    applied = apply_scenario(_counted_baseline(), sc)
    assert applied.reassigned_project_ids == ("p-gr",)
    assert _leader_of(applied.schedule_input, "p-gr") == "eng-gr-b"
    all_counted = apply_scenario(_counted_baseline(True), sc)
    assert _leader_of(all_counted.schedule_input, "p-gr") == "eng-a-theoni"

    # No counted designer left in the capacity hub: the orphan stays leaderless
    # (LEFT_OUT / no_leader), never handed to the non-counted engineer.
    only_theoni = apply_scenario(
        _counted_baseline(), Scenario(remove_engineers=("eng-gr", "eng-gr-b"))
    )
    assert _leader_of(only_theoni.schedule_input, "p-gr") is None
    out = run_greedy_sgs(only_theoni.schedule_input)
    assert _by_id(out)["p-gr"].no_leader and _by_id(out)["p-gr"].left_out


def test_whatif_remove_count_removes_counted_designers_only() -> None:
    sc = Scenario(remove_engineer_counts=(RemoveEngineerCount("R&D-Greece", 1),))
    # Least design led first: Theoni (5) if counted, else eng-gr (10).
    assert apply_scenario(_counted_baseline(), sc).removed_engineer_ids == ("eng-gr",)
    assert apply_scenario(_counted_baseline(True), sc).removed_engineer_ids == ("eng-a-theoni",)
    gr = {r.hub: r for r in analytic_requirements(_counted_baseline(), sc).design}["R&D-Greece"]
    assert (gr.fte_before, gr.fte_after_scenario) == (2.0, 1.0)


def test_whatif_minimum_additions_capacity_view_counts_counted_designers() -> None:
    sc = Scenario(add_projects=(AddProject("OEM-HCK", "B-OEM", count=4, priority="P1"),))
    r = solve_minimum_additions(_counted_baseline(), sc, "all_new_within_year")
    assert r.searched_designer_hubs == ("R&D-Greece",)
    assert r.achieved is not None
    added = sum(n for hub, n in r.additions.designers if hub == "R&D-Greece")
    after = {u.key: u for u in r.achieved.utilization_after}["R&D-Greece"]
    assert after.units == 2.0 + added  # Theoni's 1.0 FTE never counts
    before = {u.key: u for u in r.achieved.utilization_before}["R&D-Greece"]
    assert before.units == 2.0


def test_whatif_all_counted_is_byte_identical_to_unflagged() -> None:
    """Regression: an explicit `counts_in_capacity=True` everywhere (and the
    pre-P29-T05 default) give identical what-if results."""

    base = _counted_baseline(True)
    unflagged_si = replace(
        base.schedule,
        engineers=tuple(
            EngineerInput(e.engineer_id, e.name, e.hub, e.allowed_categories, e.fte)
            for e in base.schedule.engineers
        ),
    )
    unflagged = replace(base, schedule=unflagged_si)
    sc = Scenario(
        add_projects=(AddProject("OEM-HCK", "B-OEM", count=2),),
        remove_engineer_counts=(RemoveEngineerCount("R&D-Greece", 1),),
    )
    assert repr(analytic_requirements(base, sc)) == repr(analytic_requirements(unflagged, sc))
    assert repr(simulate(base, sc)) == repr(simulate(unflagged, sc))
