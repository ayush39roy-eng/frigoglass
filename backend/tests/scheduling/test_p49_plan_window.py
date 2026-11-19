"""P49-T02 -- plan import "Plan from" / "Plan until" weeks (ADR 0061, R49-7..R49-21, I54, I56).

Synthetic baselines only (`_whatif_fixtures`; CURRENT_WEEK = 31). Hand figures
(DOMAIN_RULES "Lead times"), PDD / B: A1 D1 E4 H6 J1 K2 L1 M1 N1 (design 10).

Byte identity: `PRE_R49_SHA256` are the sha256 of `to_jsonable(result)` (JSON,
sorted keys) produced by the code *before* R49 (captured 2026-11-19 on the
same scenarios). With f and u unset (or f = cw, u = the preset) the response
minus the two new fields must hash the same.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
from collections.abc import Callable

import pytest

from scheduling.invariants import check_plan_from_floor, check_plan_window
from scheduling.plan_import import (
    ImportNewEngineer,
    ImportProject,
    PlanImportProject,
    PlanImportRequest,
    PlanImportResult,
    PlanImportStep,
    StepEdit,
    build_plan_import_input,
    plan_from_label,
    run_plan_import,
)
from scheduling.whatif import WhatIfBaseline, to_jsonable
from tests.scheduling._whatif_fixtures import CURRENT_WEEK, portfolio_baseline, tiny_baseline

CW = CURRENT_WEEK


def row(
    n: int,
    *,
    cat: str = "B",
    status: str = "In Queue",
    prio: str = "P3",
    rank: int | None = None,
    leader: str | None = "e0",
    stage: str | None = None,
    hub: str = "R&D-Greece",
    replaces: str | None = None,
) -> ImportProject:
    return ImportProject(
        key=f"row-{n}",
        name=f"Imported {n}",
        hub=hub,
        category=cat,
        status=status,
        priority=prio,
        rank=rank,
        file_row=n,
        leader=leader,
        current_step_id=stage,
        step_weeks=(),
        certification_testing_required=True,
        replaces_project_id=replaces,
    )


def by_ref(res: PlanImportResult, ref: str) -> PlanImportProject:
    return next(p for p in res.projects if p.ref == ref)


def step(proj: PlanImportProject, sid: str) -> PlanImportStep:
    return next(s for s in proj.steps if s.step_id == sid)


# --- scenarios (identical to the pre-R49 capture) --------------------------------------


def _tiny_scenario() -> tuple[WhatIfBaseline, PlanImportRequest]:
    return tiny_baseline(engineers=2), PlanImportRequest(
        projects=(
            row(1),
            row(2, status="In Development", stage="PDD-E", prio="P1"),
            row(3, status="Under Industrialization", stage="PDD-B", leader=None),
        ),
        mode="file_only",
        edits=(
            StepEdit("row-1", "PDD-H", None, 60, None),
            StepEdit("row-2", "PDD-E", 3, None, None),
        ),
    )


def _portfolio_rows() -> tuple[ImportProject, ...]:
    rows: list[ImportProject] = []
    statuses = ["In Queue", "In Development", "Under Industrialization", "In Buyoff", "On Hold"]
    for i, st in enumerate(statuses):
        for j, hub in enumerate(["R&D-Greece", "PD-India", "PD-Romania"]):
            n = 10 + i * 3 + j
            rows.append(
                row(
                    n,
                    cat="ABC"[(i + j) % 3],
                    status=st,
                    prio=["P1", "P2", "P3"][(i + j) % 3],
                    rank=n if j == 0 else None,
                    leader=None,
                    stage="PDD-E" if st != "In Queue" else None,
                    hub=hub,
                    replaces=f"p00{i + 1}" if j == 1 else None,
                )
            )
    rows.append(row(99, leader="new:1", stage="PDD-D", status="In Development"))
    return tuple(rows)


def _portfolio_scenario(mode: str, pyew: int) -> tuple[WhatIfBaseline, PlanImportRequest]:
    edit2 = (
        StepEdit("p007", "PDD-H", None, 50, None)
        if mode == "merge"
        else StepEdit("row-11", "PDD-K", None, 70, 1)
    )
    return portfolio_baseline(), PlanImportRequest(
        projects=_portfolio_rows(),
        mode=mode,
        plan_year_end_week=pyew,
        new_engineers=(ImportNewEngineer("new:1", "N", "R&D-Greece", 0.5),),
        edits=(StepEdit("row-10", "PDD-H", 2, 45, None), edit2),
    )


SCENARIOS: dict[str, Callable[[], tuple[WhatIfBaseline, PlanImportRequest]]] = {
    "tiny_fo": _tiny_scenario,
    "port_merge_52": lambda: _portfolio_scenario("merge", 52),
    "port_merge_104": lambda: _portfolio_scenario("merge", 104),
    "port_file_only_52": lambda: _portfolio_scenario("file_only", 52),
    "port_file_only_104": lambda: _portfolio_scenario("file_only", 104),
}

# P53-T02 (ADR 0063) re-pin: values recomputed under the P53 rules. Every
# changed field was attributed by an old/new differential (MEMORY P53-T02):
# (a) a project LEFT_OUT at the 78-week search now placed within H = cw + 260
# (portfolio p017 / p024; seed 26-00205 ...), (c) a queued P3 now counted
# (R53-2: p003 / p009 / p023, import rows "In Queue" P3), and for plan import
# R53-4 (`horizon_weeks` = H not u + 26; the QUEUED issue no longer raised).
PRE_R49_SHA256 = {
    "port_file_only_104": "35706cbf7c0b0d29ddef68ed28739d05a31f9835c496664005fc5458c1d9ffb6",
    "port_file_only_52": "1bc760aa62fead64cf0b1f72d4ec70b7f54d46620769d72e349b6b7b2b54c820",
    "port_merge_104": "01e04303cb5787253e8189ff7b95ddaabfb2d08cea84a42dfeafa43d3b5ba3c2",
    "port_merge_52": "63014fba1eb4d4336acbc988df6c199b64cc7050ac1f0bc4a2ca82ab8214b212",
    "tiny_fo": "056bbba41523307253bfdc41367bf8bb11a689b1259e6183d3b208e358e40d12",
}


def _pre_r49_hash(res: PlanImportResult) -> str:
    d = to_jsonable(res)
    assert isinstance(d, dict)
    d.pop("plan_from_week")
    d.pop("plan_until_week")
    return hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()


# =====================================================================================
# I54 / I56 identity: unset, f = cw and u = preset give the pre-R49 response
# =====================================================================================


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_unset_and_defaults_are_byte_identical_to_pre_r49(name: str) -> None:
    base, req = SCENARIOS[name]()
    res = run_plan_import(base, req)
    assert _pre_r49_hash(res) == PRE_R49_SHA256[name]
    assert res.plan_from_week == CW and res.plan_until_week == req.plan_year_end_week
    explicit = dataclasses.replace(req, plan_from_week=CW, plan_until_week=req.plan_year_end_week)
    res2 = run_plan_import(base, explicit)
    assert res2 == res
    assert build_plan_import_input(base, explicit) == build_plan_import_input(base, req)
    assert check_plan_from_floor(base, explicit, res2) == ()
    assert check_plan_window(base, explicit, res2) == ()


# =====================================================================================
# Plan from (R49-7..R49-12, I54)
# =====================================================================================


@pytest.mark.parametrize("name", sorted(SCENARIOS))
@pytest.mark.parametrize("f", [CW + 1, 45, 52])
def test_plan_from_floor_holds(name: str, f: int) -> None:
    base, req = SCENARIOS[name]()
    req = dataclasses.replace(req, plan_from_week=f)
    res = run_plan_import(base, req)
    assert res.plan_from_week == f and res.current_week == CW
    assert check_plan_from_floor(base, req, res) == ()
    assert check_plan_window(base, req, res) == ()
    ref = run_plan_import(base, dataclasses.replace(req, plan_from_week=None))
    # Unchanged by f: horizon, windows, the weekly series' week range.
    assert res.horizon_weeks == ref.horizon_weeks
    assert res.capacity.windows == ref.capacity.windows
    assert res.capacity.weekly.weeks == ref.capacity.weekly.weeks


def test_plan_from_anchors_in_progress_and_floors_not_started() -> None:
    base, req = _tiny_scenario()
    req = dataclasses.replace(req, plan_from_week=40)
    res = run_plan_import(base, req)
    dev = by_ref(res, "row-2")
    e = step(dev, "PDD-E")
    assert e.status == "In Progress" and e.start_week == 40
    # Edit duration 3 keeps the In Progress step at 3 weeks from f.
    assert (e.start_week, e.end_week) == (40, 42)
    assert e.start_not_before_week is None  # f is not reported as an edit
    for p in res.projects:
        for s in p.steps:
            if not s.skipped and s.start_week is not None:
                assert s.start_week >= 40
    q = by_ref(res, "row-1")
    # Planner edit 60 stays served and dominates f; other steps serve None.
    assert step(q, "PDD-H").start_not_before_week == 60
    assert wk_ge(step(q, "PDD-H").start_week, 60)
    assert step(q, "PDD-A").start_not_before_week is None
    # Solver input: anchor at f, floors max(edit, f) on Not Started steps.
    si = build_plan_import_input(base, req)
    pid2 = by_ref(res, "row-2").project_id
    p2 = next(p for p in si.projects if p.project_id == pid2)
    assert [(r.step_id, r.actual_start_week) for r in p2.step_progress] == [("PDD-E", 40)]
    pid1 = by_ref(res, "row-1").project_id
    p1 = next(p for p in si.projects if p.project_id == pid1)
    floors = {r.step_id: r.start_not_before_week for r in p1.step_timing}
    assert floors["PDD-A"] == 40 and floors["PDD-H"] == 60
    assert "Plan year ends week 104" in res.workings[1]
    assert res.workings[1].endswith("today is week 31; file projects start from W40.")


def wk_ge(x: int | None, floor: int) -> bool:
    return x is not None and x >= floor


def test_plan_from_label_next_year() -> None:
    assert plan_from_label(40) == "W40"
    assert plan_from_label(52) == "W52"
    assert plan_from_label(53) == "2027 W1"
    assert plan_from_label(70) == "2027 W18"


def test_plan_from_leaves_plan_projects_inputs_identical() -> None:
    base, req = _portfolio_scenario("merge", 104)
    late = dataclasses.replace(req, plan_from_week=60)
    a = build_plan_import_input(base, req)
    b = build_plan_import_input(base, late)
    file_ids = {p.project_id for p in a.projects if p.project_id.startswith("imp-")}
    assert {p.project_id: p for p in a.projects if p.project_id not in file_ids} == {
        p.project_id: p for p in b.projects if p.project_id not in file_ids
    }
    assert (a.engineers, a.chambers, a.current_week, a.horizon_weeks, a.within_year_week) == (
        b.engineers,
        b.chambers,
        b.current_week,
        b.horizon_weeks,
        b.within_year_week,
    )
    res = run_plan_import(base, late)
    assert check_plan_from_floor(base, late, res) == ()


@pytest.mark.parametrize("bad", [CW - 1, 105, 0, True])
def test_plan_from_out_of_range_is_rejected(bad: object) -> None:
    base, req = _tiny_scenario()
    with pytest.raises(ValueError, match="plan_from_week"):
        run_plan_import(base, dataclasses.replace(req, plan_from_week=bad))  # type: ignore[arg-type]


def test_plan_from_above_the_preset_or_window_is_rejected() -> None:
    base, req = _tiny_scenario()
    with pytest.raises(ValueError, match="plan_from_week"):
        run_plan_import(base, dataclasses.replace(req, plan_year_end_week=52, plan_from_week=53))
    with pytest.raises(ValueError, match="plan_from_week"):
        run_plan_import(base, dataclasses.replace(req, plan_from_week=50, plan_until_week=45))


# =====================================================================================
# Plan until (R49-15..R49-18, I56)
# =====================================================================================


@pytest.mark.parametrize("name", sorted(SCENARIOS))
@pytest.mark.parametrize("u", [CW, 40, 52, 53, 70, 104])
def test_plan_window_holds(name: str, u: int) -> None:
    base, req = SCENARIOS[name]()
    # P53 (R53-4): the import searches to the live H (cw + 260 = 291 here),
    # whatever u is; u only cuts "within".
    h = base.schedule.horizon_weeks
    assert h == CW + 260
    req = dataclasses.replace(req, plan_until_week=u)
    res = run_plan_import(base, req)
    assert res.plan_until_week == u and res.horizon_weeks == h
    assert res.plan_year_end_week == req.plan_year_end_week  # preset echo
    assert check_plan_window(base, req, res) == ()
    assert check_plan_from_floor(base, req, res) == ()
    si = build_plan_import_input(base, req)
    assert (si.within_year_week, si.horizon_weeks) == (u, h)


def test_plan_until_windows_and_wording() -> None:
    base, req = _tiny_scenario()
    res = run_plan_import(base, dataclasses.replace(req, plan_until_week=70, plan_from_week=40))
    assert [(w.key, w.label, w.from_week, w.to_week) for w in res.capacity.windows] == [
        ("y0", "2026 W31–W52", 31, 52),
        ("y1", "2027 W1–W18", 53, 70),
    ]
    assert res.capacity.weekly.weeks == tuple(range(31, 71))
    assert res.workings[1].startswith("Plan window ends week 70; search horizon week 291;")
    res52 = run_plan_import(base, dataclasses.replace(req, plan_until_week=45))
    assert [(w.key, w.from_week, w.to_week) for w in res52.capacity.windows] == [("y0", 31, 45)]
    for i in res52.issues:
        if i.code == "UNREACHABLE_IN_YEAR":
            assert i.message.endswith("after the plan window (week 45).")
    assert any(i.code == "UNREACHABLE_IN_YEAR" for i in res52.issues)


def test_plan_until_cut_off_in_both_merge_runs() -> None:
    base, req = _portfolio_scenario("merge", 104)
    req = dataclasses.replace(req, plan_until_week=60)
    res = run_plan_import(base, req)
    for p in res.projects:
        if p.before_outcome == "within_year":
            assert p.before_finish_week is not None and p.before_finish_week <= 60
        if p.before_outcome == "spillover":
            assert p.before_finish_week is not None and p.before_finish_week > 60
    assert check_plan_window(base, req, res) == ()


@pytest.mark.parametrize("bad", [CW - 1, CW + 261, True])
def test_plan_until_out_of_range_is_rejected(bad: object) -> None:
    base, req = _tiny_scenario()
    with pytest.raises(ValueError, match="plan_until_week"):
        run_plan_import(base, dataclasses.replace(req, plan_until_week=bad))  # type: ignore[arg-type]


def test_plan_until_accepts_any_week_up_to_h_and_later_year_windows() -> None:
    # P53 (R53-4): u up to H = cw + 260; one capacity window per calendar year.
    base, req = _tiny_scenario()
    res = run_plan_import(base, dataclasses.replace(req, plan_until_week=CW + 260))
    assert [(w.key, w.label, w.from_week, w.to_week) for w in res.capacity.windows] == [
        ("y0", "2026 W31–W52", 31, 52),
        ("y1", "2027", 53, 104),
        ("y2", "2028", 105, 156),
        ("y3", "2029", 157, 208),
        ("y4", "2030", 209, 260),
        ("y5", "2031 W1–W31", 261, 291),
    ]
    assert check_plan_window(base, dataclasses.replace(req, plan_until_week=CW + 260), res) == ()
    for pyew in (156, 260):
        run_plan_import(base, dataclasses.replace(req, plan_year_end_week=pyew))
    for pyew in (312, 100, 0):
        with pytest.raises(ValueError, match="plan_year_end_week"):
            run_plan_import(base, dataclasses.replace(req, plan_year_end_week=pyew))


def test_plan_until_bounds_the_edit_floor() -> None:
    # P53 (R53-4): the edit floor is bounded by the search limit H, not u + 26.
    base, req = _tiny_scenario()
    late = (StepEdit("row-1", "PDD-H", None, CW + 261, None),)
    with pytest.raises(ValueError, match="start_not_before_week"):
        run_plan_import(base, dataclasses.replace(req, plan_until_week=52, edits=late))
    ok = (StepEdit("row-1", "PDD-H", None, 80, None),)
    run_plan_import(base, dataclasses.replace(req, plan_until_week=52, edits=ok))


# =====================================================================================
# Selftest direction 2: broken results are caught
# =====================================================================================


def _broken_step(res: PlanImportResult, ref: str, sid: str, **changes: object) -> PlanImportResult:
    projects = []
    for p in res.projects:
        if p.ref == ref:
            p = dataclasses.replace(
                p,
                steps=tuple(
                    dataclasses.replace(s, **changes) if s.step_id == sid else s  # type: ignore[arg-type]
                    for s in p.steps
                ),
            )
        projects.append(p)
    return dataclasses.replace(res, projects=tuple(projects))


def test_i54_catches_broken_results() -> None:
    base, req = _tiny_scenario()
    req = dataclasses.replace(req, plan_from_week=40)
    res = run_plan_import(base, req)
    assert check_plan_from_floor(base, req, res) == ()
    cases = [
        dataclasses.replace(res, plan_from_week=CW),
        dataclasses.replace(res, current_week=40),
        _broken_step(res, "row-2", "PDD-E", start_week=CW),
        _broken_step(res, "row-1", "PDD-A", start_week=39),
        _broken_step(res, "row-1", "PDD-A", start_not_before_week=40),
        _broken_step(res, "row-1", "PDD-H", start_not_before_week=None),
    ]
    for broken in cases:
        v = check_plan_from_floor(base, req, broken)
        assert v and all(x.invariant == "I54" for x in v)


def test_i56_catches_broken_results() -> None:
    base, req = _tiny_scenario()
    req = dataclasses.replace(req, plan_until_week=70)
    res = run_plan_import(base, req)
    assert check_plan_window(base, req, res) == ()
    cap = res.capacity
    within = next(p for p in res.projects if p.outcome == "within_year")
    moved = tuple(
        dataclasses.replace(p, finish_week=71) if p.ref == within.ref else p for p in res.projects
    )
    cases = [
        dataclasses.replace(res, plan_until_week=104),
        dataclasses.replace(res, horizon_weeks=130),
        dataclasses.replace(res, projects=moved),
        dataclasses.replace(
            res,
            capacity=dataclasses.replace(
                cap, weekly=dataclasses.replace(cap.weekly, weeks=tuple(range(31, 105)))
            ),
        ),
        dataclasses.replace(res, capacity=dataclasses.replace(cap, windows=cap.windows[:1])),
    ]
    for broken in cases:
        v = check_plan_window(base, req, broken)
        assert v and all(x.invariant == "I56" for x in v)
