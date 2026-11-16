"""P33-T03 — category scheduling order from data (ADR 0047 §3 as ruled: R33-7,
R33-8; DOMAIN_RULES "Category templates" §E; I30).

`ScheduleInput.categories` defaults to the seven seeded categories at ranks
1..7 (`CATEGORY_RANK` order), so every pre-P33 caller is unchanged. Sort key
5 is the category's rank *value*. A category added between B and C (the
"+ Add category" flow renumbers ranks densely) orders its projects between
B's and C's and changes nothing else.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from scheduling import (
    CATEGORY_RANK,
    CategoryInput,
    ChamberInput,
    EngineerInput,
    InvariantViolation,
    LeadTime,
    ProjectInput,
    ScheduleInput,
    ScheduleOutput,
    build_category_maps,
    canonical_categories,
    default_categories,
    is_default_categories,
    run_cp_sat,
    run_greedy_sgs,
    validate_invariants,
)
from scheduling._selftest_common import SELFTEST_WEEK
from scheduling.greedy import _cat_not_allowed, _sort_key, prepare_run
from scheduling.plan_import import _new_engineer_categories
from scheduling.types import default_lead_times
from scheduling.whatif import WhatIfBaseline, _default_allowed_categories, _validate_scenario

CW = 31
PDD_CODES = ("A+", "A", "B", "C")
ENG = EngineerInput("eng-a", "A", "R&D-Greece", (*PDD_CODES, "B2"))
ENG_B = EngineerInput("eng-b", "B", "R&D-Greece", (*PDD_CODES, "B2"))
CH_GR = ChamberInput("ch-gr", "GR", "Greece", max_concurrent=1, allowed_stages=("PDD-F", "PDD-H"))


def _with_b2() -> tuple[CategoryInput, ...]:
    """The seeded list with B2 (PDD) inserted right after B: dense ranks 1..8."""

    order = ("A+", "A", "B", "B2", "C", "A-OEM", "B-OEM", "C-OEM")
    return tuple(
        CategoryInput(code, "OEM" if code.endswith("-OEM") else "PDD", rank)
        for rank, code in enumerate(order, start=1)
    )


def _lead_times_with(code: str, copy_from: str) -> tuple[LeadTime, ...]:
    base = default_lead_times()
    return base + tuple(replace(lt, category=code) for lt in base if lt.category == copy_from)


def _project(pid: str, category: str, **kw: object) -> ProjectInput:
    base: dict[str, object] = dict(
        project_id=pid,
        name=pid,
        hub="R&D-Greece",
        status="In Queue",
        category=category,
        priority="P2",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    base.update(kw)
    return ProjectInput(**base)  # type: ignore[arg-type]


def _ids(violations: tuple[InvariantViolation, ...]) -> set[str]:
    return {v.invariant for v in violations}


# --- The default list ------------------------------------------------------------------


def test_default_categories_are_the_seeded_seven() -> None:
    cats = default_categories()
    assert tuple(c.code for c in cats) == CATEGORY_RANK
    assert tuple(c.rank for c in cats) == (1, 2, 3, 4, 5, 6, 7)
    assert tuple(c.workflow_id for c in cats) == ("PDD",) * 4 + ("OEM",) * 3
    assert (
        ScheduleInput(current_week=SELFTEST_WEEK, projects=(), engineers=(), chambers=()).categories
        == cats
    )


def test_is_default_and_canonical_categories() -> None:
    cats = default_categories()
    assert is_default_categories(cats)
    assert is_default_categories(tuple(reversed(cats)))  # supplied order is irrelevant
    assert canonical_categories(cats) is None
    assert not is_default_categories(_with_b2())
    assert canonical_categories(_with_b2()) == [
        {"code": c.code, "workflow_id": c.workflow_id, "rank": c.rank} for c in _with_b2()
    ]
    renamed = (replace(cats[0], workflow_id="OEM"), *cats[1:])
    assert canonical_categories(renamed) is not None


def test_sort_key_rank_is_the_value_not_an_index() -> None:
    p = _project("x", "C")
    # P36 (ADR 0050): key 3a (band_rank) sits at index 3, so category is index 5.
    assert _sort_key(p)[5] == 4
    assert _sort_key(p, {"C": 40})[5] == 40


# --- Ordering ------------------------------------------------------------------------------


def _mixed_si(categories: tuple[CategoryInput, ...], *, with_b2: bool) -> ScheduleInput:
    projects = [_project(f"p-{c}", c) for c in ("C", "B", "A+", "A")]
    if with_b2:
        projects.append(_project("p-B2", "B2"))
    return ScheduleInput(
        projects=tuple(projects),
        engineers=(ENG, ENG_B),
        chambers=(CH_GR,),
        lead_times=_lead_times_with("B2", "B"),
        current_week=CW,
        categories=categories,
    )


def test_inserted_category_orders_between_b_and_c() -> None:
    si = _mixed_si(_with_b2(), with_b2=True)
    out = run_greedy_sgs(si)
    assert out.scheduling_order == ("p-A+", "p-A", "p-B", "p-B2", "p-C")
    assert validate_invariants(si, out) == ()


def test_inserted_category_changes_nothing_else() -> None:
    """Without a B2 project, the list with B2 inserted (and C..C-OEM renumbered)
    gives a byte-identical run to the default list."""

    default = run_greedy_sgs(_mixed_si(default_categories(), with_b2=False))
    inserted = run_greedy_sgs(_mixed_si(_with_b2(), with_b2=False))
    assert repr(default) == repr(inserted)
    # And with the B2 project, the other four keep their relative order.
    with_b2 = run_greedy_sgs(_mixed_si(_with_b2(), with_b2=True))
    assert tuple(p for p in with_b2.scheduling_order if p != "p-B2") == default.scheduling_order


def test_rank_values_need_not_be_dense() -> None:
    """Key 5 is the rank value: gaps in the numbering do not matter."""

    sparse = tuple(replace(c, rank=c.rank * 10) for c in _with_b2())
    a = run_greedy_sgs(_mixed_si(sparse, with_b2=True))
    b = run_greedy_sgs(_mixed_si(_with_b2(), with_b2=True))
    assert repr(a) == repr(b)


def test_reranking_moves_the_order_and_keys_1_to_4_still_win() -> None:
    reranked = (
        CategoryInput("C", "PDD", 1),
        CategoryInput("B", "PDD", 2),
        CategoryInput("A", "PDD", 3),
        CategoryInput("A+", "PDD", 4),
        CategoryInput("A-OEM", "OEM", 5),
        CategoryInput("B-OEM", "OEM", 6),
        CategoryInput("C-OEM", "OEM", 7),
    )
    si = replace(
        _mixed_si(reranked, with_b2=False),
        lead_times=default_lead_times(),
    )
    si = replace(
        si,
        projects=(*si.projects, _project("p-A-P1", "A", priority="P1")),
    )
    out = run_greedy_sgs(si)
    assert out.scheduling_order == ("p-A-P1", "p-C", "p-B", "p-A", "p-A+")
    assert validate_invariants(si, out) == ()


def test_cp_sat_uses_the_input_order_and_holds_i30() -> None:
    si = _mixed_si(_with_b2(), with_b2=True)
    out, _info = run_cp_sat(si, deterministic_time=3.0, earliness_deterministic_time=1.0)
    assert out.scheduling_order == ("p-A+", "p-A", "p-B", "p-B2", "p-C")
    assert validate_invariants(si, out, check_determinism=False) == ()


# --- Validation (R33-8) ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("categories", "match"),
    [
        ((*default_categories(), CategoryInput("A", "PDD", 9)), "more than once"),
        ((*default_categories(), CategoryInput("B2", "PDD", 3)), "rank 3"),
        ((*default_categories(), CategoryInput("B2", "PDD", 0)), "rank 0"),
        ((*default_categories(), CategoryInput("B2", "PDD", True)), "rank True"),  # type: ignore[arg-type]
        ((*default_categories(), CategoryInput("B2", "XYZ", 8)), "workflow_id 'XYZ'"),
        ((*default_categories(), CategoryInput("", "PDD", 8)), "non-empty"),
    ],
    ids=["dup-code", "dup-rank", "rank-zero", "rank-bool", "unknown-workflow", "empty-code"],
)
def test_invalid_category_lists_rejected(categories: tuple[CategoryInput, ...], match: str) -> None:
    si = _mixed_si(categories, with_b2=False)
    with pytest.raises(ValueError, match=match):
        run_greedy_sgs(si)
    # The validator reports the same list under I30 instead of raising.
    out = run_greedy_sgs(_mixed_si(default_categories(), with_b2=False))
    assert "I30" in _ids(validate_invariants(si, out, check_determinism=False))


def test_project_category_missing_from_the_list_rejected() -> None:
    si = _mixed_si(default_categories(), with_b2=True)  # B2 rows exist, B2 is not listed
    with pytest.raises(ValueError, match="category 'B2' is not one of"):
        run_greedy_sgs(si)


def test_project_category_of_another_workflow_rejected() -> None:
    cats = tuple(replace(c, workflow_id="OEM") if c.code == "B2" else c for c in _with_b2())
    si = _mixed_si(cats, with_b2=True)  # PDD lead rows for B2 exist
    with pytest.raises(ValueError, match="belongs to workflow 'OEM'"):
        run_greedy_sgs(si)


def test_default_list_is_not_checked_against_the_input_workflows() -> None:
    """The seeded list names OEM; a PDD-only template still runs (pre-P33)."""

    maps = build_category_maps(default_categories())
    assert maps.codes == CATEGORY_RANK
    with pytest.raises(ValueError, match="workflow_id 'OEM'"):
        build_category_maps(default_categories(), workflow_ids=("PDD",))


def test_prepare_run_exposes_the_maps() -> None:
    ctx = prepare_run(_mixed_si(_with_b2(), with_b2=True))
    assert ctx.categories.rank["B2"] == 4
    assert ctx.categories.codes_of_workflow("PDD") == ("A+", "A", "B", "B2", "C")
    assert ctx.categories.codes_of_workflow("OEM") == ("A-OEM", "B-OEM", "C-OEM")


# --- I30 (negative) ------------------------------------------------------------------------


def test_i30_detects_an_order_that_contradicts_the_ranks() -> None:
    si = _mixed_si(_with_b2(), with_b2=True)
    out = run_greedy_sgs(si)
    order = list(out.scheduling_order)
    order[2], order[3] = order[3], order[2]  # B2 before B
    bad = ScheduleOutput(out.project_outcomes, tuple(order))
    assert _ids(validate_invariants(si, bad, check_determinism=False)) == {"I30"}


def test_i30_detects_a_tie_out_of_project_id_order() -> None:
    si = replace(
        _mixed_si(default_categories(), with_b2=False),
        projects=(_project("p-1", "B"), _project("p-2", "B")),
    )
    out = run_greedy_sgs(si)
    assert out.scheduling_order == ("p-1", "p-2")
    bad = ScheduleOutput(out.project_outcomes, ("p-2", "p-1"))
    assert _ids(validate_invariants(si, bad, check_determinism=False)) == {"I30"}


def test_i30_ignores_pairs_that_differ_on_earlier_keys() -> None:
    si = replace(
        _mixed_si(default_categories(), with_b2=False),
        projects=(_project("p-1", "C", priority="P1"), _project("p-2", "A+")),
    )
    out = run_greedy_sgs(si)
    assert out.scheduling_order == ("p-1", "p-2")  # P1 beats a better category
    assert validate_invariants(si, out) == ()


# --- OEM test and category lists from the input (R33-8) --------------------------------------


def _with_d_oem() -> tuple[CategoryInput, ...]:
    return (*default_categories(), CategoryInput("D-OEM", "OEM", 8))


def test_cat_not_allowed_reads_the_workflow_from_the_input() -> None:
    maps = build_category_maps(_with_d_oem())
    proj = _project("o", "D-OEM", hub="OEM-HCK", workflow_id="OEM")
    named = EngineerInput("e1", "E1", "R&D-Greece", ("D-OEM",))
    blanket = EngineerInput("e2", "E2", "R&D-Greece", ("OEM",))
    other = EngineerInput("e3", "E3", "R&D-Greece", ("A-OEM",))
    assert _cat_not_allowed(proj, named, maps.workflow) is False
    assert _cat_not_allowed(proj, blanket, maps.workflow) is False
    assert _cat_not_allowed(proj, other, maps.workflow) is True
    # Without the input's list D-OEM is not known to be an OEM category.
    assert _cat_not_allowed(proj, named) is True


def test_new_oem_category_schedules_on_an_oem_hub() -> None:
    lead = _lead_times_with("D-OEM", "B-OEM")
    leader = EngineerInput("eng-o", "O", "R&D-Greece", ("D-OEM",))
    chambers = (ChamberInput("ch-o", "GR-O", "Greece", 1, ("OEM-E", "OEM-H")),)
    proj = _project("o", "D-OEM", hub="OEM-HCK", workflow_id="OEM", leader_engineer_id="eng-o")
    si = ScheduleInput(
        projects=(proj,),
        engineers=(leader,),
        chambers=chambers,
        lead_times=lead,
        current_week=CW,
        categories=_with_d_oem(),
    )
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out) == ()
    (o,) = out.project_outcomes
    assert not o.left_out and not o.cat_not_allowed


def test_whatif_and_plan_import_lists_read_the_input() -> None:
    maps = build_category_maps(_with_b2())
    assert _default_allowed_categories("R&D-Greece", maps) == ("A+", "A", "B", "B2", "C")
    oem = build_category_maps(_with_d_oem())
    assert _default_allowed_categories("OEM-HCK", oem) == (
        "OEM",
        "A-OEM",
        "B-OEM",
        "C-OEM",
        "D-OEM",
    )
    default = build_category_maps(default_categories())
    assert _default_allowed_categories("R&D-Greece", default) == PDD_CODES
    assert _new_engineer_categories("R&D-India", maps) == ("A+", "A", "B", "B2", "C")
    assert _new_engineer_categories("R&D-Greece", oem) == (
        *PDD_CODES,
        "OEM",
        "A-OEM",
        "B-OEM",
        "C-OEM",
        "D-OEM",
    )


def test_whatif_scenario_rejects_a_category_of_another_workflow() -> None:
    from scheduling.whatif import AddProject, Scenario

    cats = tuple(replace(c, workflow_id="OEM") if c.code == "B2" else c for c in _with_b2())
    base_si = replace(_mixed_si(cats, with_b2=False), lead_times=_lead_times_with("B2", "B"))
    baseline = WhatIfBaseline(schedule=base_si)
    scenario = Scenario(add_projects=(AddProject(hub="R&D-Greece", category="B2", count=1),))
    with pytest.raises(ValueError, match="not valid for workflow"):
        _validate_scenario(baseline, scenario)
    ok = WhatIfBaseline(schedule=replace(base_si, categories=_with_b2()))
    _validate_scenario(ok, scenario)
