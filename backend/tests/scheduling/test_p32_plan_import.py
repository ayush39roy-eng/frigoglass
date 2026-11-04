"""P32-T02 -- plan import into the What-if (scheduling.plan_import, ADR 0044, contract B1).

Synthetic baselines only (`_whatif_fixtures`; CURRENT_WEEK = 31). The client
workbook is never used. Hand figures (DOMAIN_RULES "Lead times"):

    PDD / A : A1 B4 C4 D1 E6 F4 G2 H6 I2 J1 K2 L3 M1 N1   design 18, lab 10
    PDD / B : A1 D1 E4 H6 J1 K2 L1 M1 N1 (B C F G I = 0)  design 10, lab 6
    PDD / C : A1 D1 E2 H1 J1 K1 N1                         design 6,  lab 1
    tiny baseline: R&D-Greece wwpe 50, Greece lab 73.6 efficient weeks / year
"""

from __future__ import annotations

import dataclasses
from fractions import Fraction

import pytest

from scheduling import ProjectInput
from scheduling.plan_import import (
    MAX_IMPORT_EDITS,
    MAX_IMPORT_NEW_ENGINEERS,
    MAX_IMPORT_PROJECTS,
    ImportNewEngineer,
    ImportProject,
    PlanImportProject,
    PlanImportRequest,
    PlanImportResult,
    PlanImportStep,
    StepEdit,
    run_plan_import,
)
from scheduling.types import StepTimingInput
from scheduling.whatif import WhatIfBaseline, WhatIfBudgetExceeded, to_jsonable
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
    weeks: tuple[tuple[str, int], ...] = (),
    hub: str = "R&D-Greece",
    replaces: str | None = None,
    cert: bool = True,
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
        step_weeks=weeks,
        certification_testing_required=cert,
        replaces_project_id=replaces,
    )


def plan_project(pid: str, *, cat: str = "B", leader: str = "e0", prio: str = "P2") -> ProjectInput:
    return ProjectInput(
        project_id=pid,
        name=f"Plan {pid}",
        hub="R&D-Greece",
        status="In Queue",
        category=cat,
        priority=prio,
        frozen=False,
        leader_engineer_id=leader,
    )


def by_ref(res: PlanImportResult, ref: str) -> PlanImportProject:
    return next(p for p in res.projects if p.ref == ref)


def step(proj: PlanImportProject, sid: str) -> PlanImportStep:
    return next(s for s in proj.steps if s.step_id == sid)


def wk(x: int | None) -> int:
    assert x is not None
    return x


def codes(res: PlanImportResult, ref: str) -> set[str]:
    return {i.code for i in res.issues if i.ref == ref}


# =====================================================================================
# Merge / replace / file_only
# =====================================================================================


def test_merge_replaces_matched_project_and_keeps_the_rest() -> None:
    base = tiny_baseline(projects=(plan_project("p1"), plan_project("p2")), engineers=2)
    req = PlanImportRequest(projects=(row(5, replaces="p1"), row(6, leader="e1")), mode="merge")
    res = run_plan_import(base, req)

    refs = [p.ref for p in res.projects]
    assert refs[:2] == ["row-5", "row-6"]  # file projects first, file order
    assert "p1" not in refs and "p2" in refs
    assert res.kpis.file_projects == 2 and res.kpis.plan_projects == 1
    assert res.kpis.projects_total == 3
    r5 = by_ref(res, "row-5")
    assert r5.source == "file" and r5.replaces_project_id == "p1"
    assert r5.project_id == "imp-9999-00005-1"
    # before_* of a replacing row = the replaced project's live outcome
    assert r5.before_outcome is not None and r5.before_finish_week is not None
    p2 = by_ref(res, "p2")
    assert p2.source == "plan" and p2.before_outcome is not None
    assert res.kpis.before_within_plan_year is not None
    assert res.kpis.after_within_plan_year_existing is not None
    assert res.horizon_weeks == 130 and res.plan_year_end_week == 104


def test_file_only_schedules_only_the_file() -> None:
    base = tiny_baseline(projects=(plan_project("p1"),), engineers=1)
    res = run_plan_import(base, PlanImportRequest(projects=(row(3),), mode="file_only"))
    assert [p.ref for p in res.projects] == ["row-3"]
    assert res.kpis.plan_projects == 0 and res.kpis.projects_total == 1
    assert res.kpis.before_within_plan_year is None
    assert res.kpis.after_within_plan_year_existing is None
    assert res.changes.newly_slipping == res.changes.recovered == res.changes.moved == ()
    assert by_ref(res, "row-3").before_outcome is None
    # file_only starts from an empty designer: the file project starts at CW
    assert by_ref(res, "row-3").start_week == CW


def test_merge_with_file_load_reports_changes() -> None:
    # p1 (P3) runs first in the live plan; a P1 file row on the same designer
    # pushes it later -> a "moved" (or slipping) change.
    base = tiny_baseline(projects=(plan_project("p1", prio="P3"),), engineers=1)
    res = run_plan_import(base, PlanImportRequest(projects=(row(2, prio="P1", cat="A"),)))
    changes = res.changes.moved + res.changes.newly_slipping
    assert [c.ref for c in changes] == ["p1"]
    assert wk(changes[0].after_finish_week) > wk(changes[0].before_finish_week)


def test_unknown_replaces_and_unknown_leader_are_value_errors() -> None:
    base = tiny_baseline()
    with pytest.raises(ValueError, match="replaces"):
        run_plan_import(base, PlanImportRequest(projects=(row(1, replaces="nope"),)))
    with pytest.raises(ValueError, match="leader"):
        run_plan_import(base, PlanImportRequest(projects=(row(1, leader="ghost"),)))
    with pytest.raises(ValueError, match="mode"):
        run_plan_import(base, PlanImportRequest(projects=(), mode="other"))
    with pytest.raises(ValueError, match="plan_year_end_week"):
        run_plan_import(base, PlanImportRequest(projects=(), plan_year_end_week=78))


# =====================================================================================
# Rank ordering inside a band
# =====================================================================================


def test_ranks_order_inside_the_band() -> None:
    base = tiny_baseline(engineers=1)
    rows = (
        row(10, prio="P1", rank=3),
        row(11, prio="P1", rank=1),
        row(12, prio="P1", rank=2),
        row(13, prio="P1", rank=None),  # unranked P1 last in the band
        row(14, prio="P2", rank=None),
    )
    res = run_plan_import(base, PlanImportRequest(projects=rows, mode="file_only"))
    assert res.scheduling_order == ("row-11", "row-12", "row-10", "row-13", "row-14")
    finishes = [wk(by_ref(res, r).finish_week) for r in res.scheduling_order]
    assert finishes == sorted(finishes) and len(set(finishes)) == 5  # one designer: serial
    assert by_ref(res, "row-11").project_id == "imp-0001-00011-1"


def test_expanded_rows_with_same_file_row_get_distinct_ids() -> None:
    base = tiny_baseline(engineers=1)
    a = dataclasses.replace(row(7), key="row-7-1", name="X (1/2)")
    b = dataclasses.replace(row(7), key="row-7-2", name="X (2/2)")
    res = run_plan_import(base, PlanImportRequest(projects=(a, b), mode="file_only"))
    assert [p.project_id for p in res.projects] == ["imp-9999-00007-1", "imp-9999-00007-2"]


# =====================================================================================
# Stage: ancestors done, In Progress anchoring
# =====================================================================================


def test_in_development_ancestors_done_and_current_step_in_progress() -> None:
    base = tiny_baseline(engineers=1)
    r = row(4, cat="A", status="In Development", stage="PDD-E")
    res = run_plan_import(base, PlanImportRequest(projects=(r,), mode="file_only"))
    p = by_ref(res, "row-4")
    for sid in ("PDD-A", "PDD-B", "PDD-C", "PDD-D"):
        s = step(p, sid)
        assert s.done_before_import and s.skipped and s.duration_weeks == 0
        assert s.status == "Done" and s.editable == "none" and s.span_weeks == 0
        assert s.duration_override_weeks == 0
    e = step(p, "PDD-E")
    assert not e.done_before_import and e.status == "In Progress" and e.editable == "resize"
    assert (e.start_week, e.end_week, e.span_weeks) == (CW, CW + 5, 6)
    assert e.engineer_id == "e0"
    f = step(p, "PDD-F")
    assert f.status == "Not Started" and f.editable == "move_resize" and f.chamber_id == "c0"
    assert p.start_week == CW


def test_in_progress_anchor_is_not_moved_by_a_busy_designer() -> None:
    # Anchored work is booked before any search: a live P1 project on e0 waits
    # for the In Development row, and an In Queue row waits for both. Two
    # In Development rows on one designer are both anchored at CW: ENG_CONFLICT.
    base = tiny_baseline(projects=(plan_project("p1", cat="A", prio="P1"),), engineers=1)
    dev = row(4, cat="B", status="In Development", stage="PDD-E", prio="Q")
    que = row(5, cat="B", status="In Queue", stage="PDD-E", prio="Q")
    res = run_plan_import(base, PlanImportRequest(projects=(dev, que)))
    d, q, p1 = by_ref(res, "row-4"), by_ref(res, "row-5"), by_ref(res, "p1")
    assert step(d, "PDD-E").start_week == CW and not d.eng_conflict
    assert p1.start_week is not None and p1.start_week > CW
    assert step(q, "PDD-E").status == "Not Started"
    assert wk(step(q, "PDD-E").start_week) > CW

    dev2 = row(6, cat="C", status="In Development", stage="PDD-E", prio="Q")
    res2 = run_plan_import(base, PlanImportRequest(projects=(dev, dev2), mode="file_only"))
    for ref in ("row-4", "row-6"):
        pr = by_ref(res2, ref)
        assert step(pr, "PDD-E").start_week == CW
        assert pr.eng_conflict and "ENG_CONFLICT" in codes(res2, ref)


def test_skipped_current_step_moves_in_progress_to_next_step() -> None:
    base = tiny_baseline(engineers=1)
    # Category B: PDD-B is 0 weeks -> stage PDD-B: ancestors {A}; B skipped; C 0; D in progress
    r = row(4, cat="B", status="Under Industrialization", stage="PDD-B")
    res = run_plan_import(base, PlanImportRequest(projects=(r,), mode="file_only"))
    p = by_ref(res, "row-4")
    assert step(p, "PDD-A").done_before_import
    assert not step(p, "PDD-B").done_before_import and step(p, "PDD-B").skipped
    assert step(p, "PDD-D").status == "In Progress" and step(p, "PDD-D").start_week == CW


def test_file_step_weeks_override_and_zero_skips() -> None:
    base = tiny_baseline(engineers=1)
    weeks = (("PDD-A", 2), ("PDD-E", 0), ("PDD-H", 3))
    res = run_plan_import(
        base, PlanImportRequest(projects=(row(1, cat="B", weeks=weeks),), mode="file_only")
    )
    p = by_ref(res, "row-1")
    assert step(p, "PDD-A").duration_weeks == 2 and step(p, "PDD-A").span_weeks == 2
    assert step(p, "PDD-E").skipped and step(p, "PDD-E").editable == "none"
    assert step(p, "PDD-H").duration_weeks == 3
    assert step(p, "PDD-K").duration_weeks == 2  # not given -> app table


def test_step_not_in_category_stays_skipped_and_is_reported() -> None:
    base = tiny_baseline(engineers=1)
    r = row(1, cat="B", weeks=(("PDD-B", 3), ("PDD-F", 2)))
    res = run_plan_import(base, PlanImportRequest(projects=(r,), mode="file_only"))
    p = by_ref(res, "row-1")
    assert step(p, "PDD-B").skipped and step(p, "PDD-F").skipped
    msgs = [i for i in res.issues if i.ref == "row-1" and i.code == "STEP_NOT_IN_CATEGORY"]
    assert len(msgs) == 2


# =====================================================================================
# Leaders: auto-assign and new designers
# =====================================================================================


def test_auto_assign_spreads_over_the_capacity_hub() -> None:
    base = tiny_baseline(engineers=3)
    rows = tuple(row(n, leader=None) for n in (1, 2, 3))
    res = run_plan_import(base, PlanImportRequest(projects=rows, mode="file_only"))
    leaders = [by_ref(res, f"row-{n}").leader_ref for n in (1, 2, 3)]
    assert sorted(str(x) for x in leaders) == ["e0", "e1", "e2"]
    for n in (1, 2, 3):
        assert by_ref(res, f"row-{n}").leader_auto_assigned
        assert "LEADER_AUTO_ASSIGNED" in codes(res, f"row-{n}")
    # all three start at CW in parallel
    assert {by_ref(res, f"row-{n}").start_week for n in (1, 2, 3)} == {CW}


def test_auto_assign_accounts_for_existing_load() -> None:
    # e0 already leads two plan projects; the auto pick goes to e1.
    base = tiny_baseline(projects=(plan_project("p1"), plan_project("p2")), engineers=2)
    res = run_plan_import(base, PlanImportRequest(projects=(row(1, leader=None),)))
    assert by_ref(res, "row-1").leader_ref == "e1"


def test_auto_assign_without_designers_is_left_out_no_leader() -> None:
    base = tiny_baseline(engineers=1)
    r = row(1, leader=None, hub="PD-Romania")  # no Romania designer in the tiny baseline
    res = run_plan_import(base, PlanImportRequest(projects=(r,), mode="file_only"))
    p = by_ref(res, "row-1")
    assert p.outcome == "left_out" and p.no_leader and not p.leader_auto_assigned
    assert "LEFT_OUT" in codes(res, "row-1")


def test_new_designer_adds_capacity_and_leads() -> None:
    base = tiny_baseline(engineers=1)
    ne = ImportNewEngineer(key="new:1", name="Somebody", hub="R&D-Greece", fte=1.0)
    req = PlanImportRequest(
        projects=(row(1, leader="new:1"),), new_engineers=(ne,), mode="file_only"
    )
    res = run_plan_import(base, req)
    p = by_ref(res, "row-1")
    assert p.leader_ref == "new:1" and step(p, "PDD-A").engineer_id == "new:1"
    assert "NEW_DESIGNER" in codes(res, "row-1")
    greece = next(h for h in res.capacity.hubs if h.hub == "R&D-Greece")
    assert greece.fte == 2.0
    y1 = next(w for w in greece.windows if w.key == "y1")
    # 2 designers x 50 working weeks / 52 per week x 52 weeks = 100
    assert y1.capacity_weeks == 100.0
    d = next(d for d in res.capacity.designers if d.ref == "new:1")
    assert d.is_new and d.counts_in_capacity
    # nothing leaks the name
    assert "Somebody" not in repr(to_jsonable(res))


def test_new_designer_validation() -> None:
    base = tiny_baseline()
    bad_hub = ImportNewEngineer(key="new:1", name="x", hub="OEM-HCK")
    with pytest.raises(ValueError, match="capacity hub"):
        run_plan_import(base, PlanImportRequest(projects=(), new_engineers=(bad_hub,)))
    clash = ImportNewEngineer(key="e0", name="x", hub="R&D-Greece")
    with pytest.raises(ValueError, match="key"):
        run_plan_import(base, PlanImportRequest(projects=(), new_engineers=(clash,)))
    zero = ImportNewEngineer(key="new:1", name="x", hub="R&D-Greece", fte=0.0)
    with pytest.raises(ValueError, match="fte"):
        run_plan_import(base, PlanImportRequest(projects=(), new_engineers=(zero,)))


# =====================================================================================
# Edits (duration, floor, overlap) on file and plan projects
# =====================================================================================


def test_edits_on_a_file_project() -> None:
    base = tiny_baseline(engineers=1)
    r = row(1, cat="A")
    edits = (
        StepEdit("row-1", "PDD-E", 3, None, None),
        StepEdit("row-1", "PDD-K", None, 90, None),
    )
    res = run_plan_import(base, PlanImportRequest(projects=(r,), edits=edits, mode="file_only"))
    p = by_ref(res, "row-1")
    e = step(p, "PDD-E")
    assert e.duration_weeks == 3 and e.span_weeks == 3 and e.duration_override_weeks == 3
    k = step(p, "PDD-K")
    assert k.start_week is not None and k.start_week >= 90 and k.start_not_before_week == 90


def test_overlap_edit_starts_a_step_before_its_predecessor_ends() -> None:
    base = tiny_baseline(engineers=1)
    r = row(1, cat="A")
    plain = run_plan_import(base, PlanImportRequest(projects=(r,), mode="file_only"))
    g_end = step(by_ref(plain, "row-1"), "PDD-G").end_week
    assert step(by_ref(plain, "row-1"), "PDD-H").start_week == wk(g_end) + 1
    edits = (StepEdit("row-1", "PDD-H", None, None, 2),)
    res = run_plan_import(base, PlanImportRequest(projects=(r,), edits=edits, mode="file_only"))
    p = by_ref(res, "row-1")
    h = step(p, "PDD-H")
    assert h.overlap_weeks == 2
    assert h.start_week == wk(step(p, "PDD-G").end_week) - 1  # release + 1 - 2
    # successors still wait for all upstream work (G passes its end through H)
    assert wk(step(p, "PDD-I").start_week) > max(wk(h.end_week), wk(step(p, "PDD-G").end_week))
    assert wk(p.finish_week) < wk(by_ref(plain, "row-1").finish_week)


def test_edits_on_a_plan_project_replace_its_timing() -> None:
    pr = dataclasses.replace(
        plan_project("p1", cat="A"),
        step_timing=(StepTimingInput("PDD-E", 8, None), StepTimingInput("PDD-K", None, 70)),
    )
    base = tiny_baseline(projects=(pr,), engineers=1)
    # duration None keeps 8; floor cleared on K is a separate edit with all None.
    edits = (
        StepEdit("p1", "PDD-E", None, 60, None),
        StepEdit("p1", "PDD-K", None, None, None),
    )
    res = run_plan_import(base, PlanImportRequest(projects=(), edits=edits))
    p = by_ref(res, "p1")
    e = step(p, "PDD-E")
    assert e.duration_weeks == 8 and e.start_week is not None and e.start_week >= 60
    assert (e.duration_override_weeks, e.start_not_before_week) == (8, 60)
    k = step(p, "PDD-K")
    assert k.start_not_before_week is None and k.duration_override_weeks is None
    # the baseline input is untouched
    assert base.schedule.projects[0].step_timing == pr.step_timing


@pytest.mark.parametrize(
    ("edit", "match"),
    [
        (StepEdit("row-9", "PDD-E", 3, None, None), "not in the simulation"),
        (StepEdit("row-1", "PDD-Z", 3, None, None), "unknown step"),
        (StepEdit("row-1", "PDD-B", 2, None, None), "skipped"),  # done before import
        (StepEdit("row-1", "PDD-E", None, 50, None), "started"),  # In Progress floor
        (StepEdit("row-1", "PDD-E", 0, None, None), "duration_weeks"),
        (StepEdit("row-1", "PDD-F", None, 500, None), "start_not_before_week"),
    ],
)
def test_invalid_edits(edit: StepEdit, match: str) -> None:
    base = tiny_baseline(engineers=1)
    r = row(1, cat="A", status="In Development", stage="PDD-E")
    with pytest.raises(ValueError, match=match):
        run_plan_import(base, PlanImportRequest(projects=(r,), edits=(edit,), mode="file_only"))


def test_overlap_on_a_workflows_first_step_is_rejected() -> None:
    base = tiny_baseline(engineers=1)
    ed = (StepEdit("row-1", "PDD-A", None, None, 1),)
    with pytest.raises(ValueError, match="first step"):
        run_plan_import(base, PlanImportRequest(projects=(row(1),), edits=ed, mode="file_only"))


def test_overlap_on_the_first_non_ancestor_step_of_a_queue_row_is_allowed() -> None:
    base = tiny_baseline(engineers=1)
    r = row(1, cat="A", stage="PDD-E")
    edits = (StepEdit("row-1", "PDD-F", None, None, 1),)
    res = run_plan_import(base, PlanImportRequest(projects=(r,), edits=edits, mode="file_only"))
    p = by_ref(res, "row-1")
    assert step(p, "PDD-F").start_week == step(p, "PDD-E").end_week  # 1 week of overlap


def test_edit_on_a_replaced_or_file_only_plan_project_is_rejected() -> None:
    base = tiny_baseline(projects=(plan_project("p1"),), engineers=1)
    ed = (StepEdit("p1", "PDD-E", 3, None, None),)
    with pytest.raises(ValueError, match="not in the simulation"):
        run_plan_import(base, PlanImportRequest(projects=(row(1, replaces="p1"),), edits=ed))
    with pytest.raises(ValueError, match="not in the simulation"):
        run_plan_import(base, PlanImportRequest(projects=(), edits=ed, mode="file_only"))


# =====================================================================================
# Plan year 52 vs 104
# =====================================================================================


def test_plan_year_verdicts_52_vs_104() -> None:
    base = tiny_baseline(engineers=1)
    # A+ critical path 44 weeks from CW 31 -> ends ~W74: past W52, inside W104.
    r = row(1, cat="A+")
    y52 = run_plan_import(
        base, PlanImportRequest(projects=(r,), mode="file_only", plan_year_end_week=52)
    )
    y104 = run_plan_import(
        base, PlanImportRequest(projects=(r,), mode="file_only", plan_year_end_week=104)
    )
    p52, p104 = by_ref(y52, "row-1"), by_ref(y104, "row-1")
    assert p52.finish_week == p104.finish_week and 52 < wk(p52.finish_week) <= 104
    assert p52.outcome == "spillover" and not p52.within_plan_year
    assert p104.outcome == "within_year" and p104.within_plan_year
    assert "UNREACHABLE_IN_YEAR" in codes(y52, "row-1")
    assert "UNREACHABLE_IN_YEAR" not in codes(y104, "row-1")
    assert (y52.horizon_weeks, y104.horizon_weeks) == (78, 130)
    assert [w.key for w in y52.capacity.windows] == ["y0"]
    assert [(w.key, w.from_week, w.to_week) for w in y104.capacity.windows] == [
        ("y0", CW, 52),
        ("y1", 53, 104),
    ]
    assert y52.capacity.weekly.weeks == tuple(range(CW, 53))
    assert y104.capacity.weekly.weeks == tuple(range(CW, 105))
    assert y52.kpis.within_plan_year == 0 and y104.kpis.within_plan_year == 1


def test_long_project_left_out_at_52_fits_at_104() -> None:
    base = tiny_baseline(engineers=1)
    weeks = (("PDD-E", 60),)  # 60-week design step from CW 31 cannot end by W78
    r = row(1, cat="B", weeks=weeks)
    y52 = run_plan_import(
        base, PlanImportRequest(projects=(r,), mode="file_only", plan_year_end_week=52)
    )
    y104 = run_plan_import(base, PlanImportRequest(projects=(r,), mode="file_only"))
    assert by_ref(y52, "row-1").outcome == "left_out"
    assert by_ref(y104, "row-1").outcome in ("within_year", "spillover")


# =====================================================================================
# Capacity sums
# =====================================================================================


def _sum2(xs: tuple[float, ...]) -> float:
    return float(sum(Fraction(str(x)) for x in xs))


def test_capacity_sums_reconcile() -> None:
    base = portfolio_baseline()
    rows = (
        row(1, cat="A", leader=None),
        row(2, cat="B", leader=None, hub="PD-India"),
        row(3, cat="A-OEM", leader=None, hub="OEM-HCK"),
        row(4, cat="C", leader=None, hub="PD-Romania", status="In Development", stage="PDD-D"),
    )
    res = run_plan_import(base, PlanImportRequest(projects=rows))
    cap = res.capacity
    n = len(cap.weekly.weeks)
    for h in cap.hubs:
        series = cap.weekly.hubs[h.hub]
        assert len(series.load) == len(series.capacity) == n
        for w in h.windows:
            win = next(x for x in cap.windows if x.key == w.key)
            i0, i1 = win.from_week - cap.weekly.weeks[0], win.to_week - cap.weekly.weeks[0]
            assert abs(_sum2(series.load[i0 : i1 + 1]) - w.load_weeks) <= 0.005 * (i1 - i0 + 1)
            assert abs(_sum2(series.capacity[i0 : i1 + 1]) - w.capacity_weeks) <= 0.005 * (
                i1 - i0 + 1
            )
    # capacity rows are capacity hubs only (OEM load lands on Greece)
    assert {h.hub for h in cap.hubs} == {"R&D-Greece", "R&D-India", "PD-India", "PD-Romania"}
    for r in cap.lab_regions:
        series = cap.weekly.lab_regions[r.region]
        total = sum(w.load_weeks for w in r.windows)
        assert abs(_sum2(series.load) - total) <= 0.01


def test_design_and_lab_load_equal_effort_booked_in_window() -> None:
    base = tiny_baseline(engineers=1)
    rows = (row(1, cat="A"), row(2, cat="B"), row(3, cat="C"))
    res = run_plan_import(base, PlanImportRequest(projects=rows, mode="file_only"))
    # everything finishes inside W31..W104
    assert all(p.finish_week is not None and p.finish_week <= 104 for p in res.projects)
    greece = next(h for h in res.capacity.hubs if h.hub == "R&D-Greece")
    assert sum(w.load_weeks for w in greece.windows) == 18 + 10 + 6
    lab = next(r for r in res.capacity.lab_regions if r.region == "Greece")
    assert sum(w.load_weeks for w in lab.windows) == 10 + 6 + 1
    # weekly capacity: 1 designer x 50 / 52; window = per week x weeks
    y0 = next(w for w in greece.windows if w.key == "y0")
    assert y0.capacity_weeks == round(50 / 52 * (52 - CW + 1), 2)
    labw = next(w for w in lab.windows if w.key == "y1")
    assert labw.capacity_weeks == round(73.6 / 52 * 52, 2)
    d = next(d for d in res.capacity.designers if d.ref == "e0")
    assert sum(w.booked_weeks for w in d.windows) == 34
    assert sum(w.booked_span_weeks for w in d.windows) == 34


def test_half_fte_designer_books_effort_not_span() -> None:
    base = tiny_baseline(engineers=1)
    half = dataclasses.replace(base.schedule.engineers[0], fte=0.5)
    base = dataclasses.replace(base, schedule=dataclasses.replace(base.schedule, engineers=(half,)))
    res = run_plan_import(base, PlanImportRequest(projects=(row(1, cat="C"),), mode="file_only"))
    p = by_ref(res, "row-1")
    assert step(p, "PDD-E").span_weeks == 4 and step(p, "PDD-E").duration_weeks == 2
    greece = next(h for h in res.capacity.hubs if h.hub == "R&D-Greece")
    assert sum(w.load_weeks for w in greece.windows) == 6
    d = next(d for d in res.capacity.designers if d.ref == "e0")
    assert sum(w.booked_weeks for w in d.windows) == 6
    assert sum(w.booked_span_weeks for w in d.windows) == 12


def test_in_progress_tail_load_is_its_remaining_effort() -> None:
    base = tiny_baseline(engineers=1)
    r = row(1, cat="A", status="In Development", stage="PDD-E")
    res = run_plan_import(base, PlanImportRequest(projects=(r,), mode="file_only"))
    greece = next(h for h in res.capacity.hubs if h.hub == "R&D-Greece")
    # done before import: A, B, D (design 1+4+1); remaining design E6 I2 J1 K2 M1 = 12
    assert sum(w.load_weeks for w in greece.windows) == 12
    first = res.capacity.weekly.hubs["R&D-Greece"].load[0]
    assert first == 1.0  # E booked from CW


# =====================================================================================
# Excluded rows, determinism, caps, budget
# =====================================================================================


def test_excluded_file_row_is_listed_and_excluded_plan_rows_omitted() -> None:
    oh = dataclasses.replace(plan_project("p9"), status="On Hold")
    base = tiny_baseline(projects=(oh,), engineers=1)
    res = run_plan_import(base, PlanImportRequest(projects=(row(1, status="On Hold"),)))
    p = by_ref(res, "row-1")
    assert p.outcome == "excluded" and not p.leader_auto_assigned
    assert all(s.editable == "none" and s.start_week is None for s in p.steps)
    assert len(p.steps) == 14
    assert "p9" not in [x.ref for x in res.projects]
    assert res.kpis.excluded == 2 and res.kpis.file_scheduled == 0


def test_determinism_and_input_order_independence() -> None:
    base = portfolio_baseline()
    rows = tuple(
        row(n, cat=("A", "B", "C")[n % 3], leader=None, rank=(n % 4) or None) for n in range(1, 13)
    )
    edits = (StepEdit("row-2", "PDD-E", 5, None, None),)
    req = PlanImportRequest(projects=rows, edits=edits)
    a = run_plan_import(base, req)
    b = run_plan_import(base, req)
    assert a == b and to_jsonable(a) == to_jsonable(b)
    shuffled = dataclasses.replace(
        base,
        schedule=dataclasses.replace(
            base.schedule,
            projects=tuple(reversed(base.schedule.projects)),
            engineers=tuple(reversed(base.schedule.engineers)),
        ),
    )
    c = run_plan_import(shuffled, dataclasses.replace(req, edits=tuple(reversed(edits))))
    assert to_jsonable(c) == to_jsonable(a)


def test_baseline_is_not_mutated() -> None:
    base = portfolio_baseline()
    snap = to_jsonable(base)
    run_plan_import(base, PlanImportRequest(projects=(row(1, leader=None),)))
    assert to_jsonable(base) == snap


def test_caps() -> None:
    base = tiny_baseline()
    many = tuple(row(n) for n in range(1, MAX_IMPORT_PROJECTS + 2))
    with pytest.raises(ValueError, match="projects"):
        run_plan_import(base, PlanImportRequest(projects=many))
    engs = tuple(
        ImportNewEngineer(f"new:{i}", "x", "R&D-Greece")
        for i in range(MAX_IMPORT_NEW_ENGINEERS + 1)
    )
    with pytest.raises(ValueError, match="designers"):
        run_plan_import(base, PlanImportRequest(projects=(), new_engineers=engs))
    edits = tuple(StepEdit("row-1", f"S{i}", None, None, None) for i in range(MAX_IMPORT_EDITS + 1))
    with pytest.raises(ValueError, match="edits"):
        run_plan_import(base, PlanImportRequest(projects=(), edits=edits))


def test_at_the_project_cap_it_runs() -> None:
    base = tiny_baseline(engineers=3)
    rows = tuple(row(n, cat="C", leader=None) for n in range(1, MAX_IMPORT_PROJECTS + 1))
    res = run_plan_import(base, PlanImportRequest(projects=rows, mode="file_only"))
    assert res.kpis.file_projects == MAX_IMPORT_PROJECTS


def test_cooperative_deadline() -> None:
    base = portfolio_baseline()
    ticks = iter(range(1000))
    with pytest.raises(WhatIfBudgetExceeded):
        run_plan_import(
            base,
            PlanImportRequest(projects=(row(1, leader=None),)),
            deadline_s=2.0,
            clock=lambda: float(next(ticks)),
        )


def test_row_validation() -> None:
    base: WhatIfBaseline = tiny_baseline()
    bad = [
        (dataclasses.replace(row(1), hub="Mars"), "hub"),
        (dataclasses.replace(row(1), category="A-OEM"), "category"),
        (dataclasses.replace(row(1), status="Shipped"), "status"),
        (dataclasses.replace(row(1), priority="P9"), "priority"),
        (dataclasses.replace(row(1), current_step_id="OEM-A"), "stage"),
        (dataclasses.replace(row(1), step_weeks=(("PDD-A", 200),)), "step_weeks"),
        (dataclasses.replace(row(1), rank=0), "rank"),
    ]
    for r, match in bad:
        with pytest.raises(ValueError, match=match):
            run_plan_import(base, PlanImportRequest(projects=(r,)))
    with pytest.raises(ValueError, match="duplicated"):
        run_plan_import(base, PlanImportRequest(projects=(row(1), row(1))))


def test_import_run_satisfies_the_invariants() -> None:
    from scheduling import run_greedy_sgs, validate_invariants
    from scheduling.plan_import import build_plan_import_input

    base = portfolio_baseline()
    rows = (
        row(1, cat="A", leader=None, rank=1, prio="P1"),
        row(2, cat="B", leader=None, hub="PD-India"),
        row(3, cat="A-OEM", leader=None, hub="OEM-HCK", status="In Development", stage="OEM-D"),
        row(4, cat="A", leader=None, status="Under Industrialization", stage="PDD-E"),
    )
    edits = (
        StepEdit("row-1", "PDD-H", None, None, 2),
        StepEdit("row-2", "PDD-E", 6, 60, None),
        StepEdit("p001", "PDD-E", None, 70, None),
    )
    req = PlanImportRequest(projects=rows, edits=edits)
    si = build_plan_import_input(base, req)
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out) == ()
    # the engine's run is exactly this run
    res = run_plan_import(base, req)
    by_pid = {o.project_id: o for o in out.project_outcomes}
    for p in res.projects:
        assert p.finish_week == by_pid[p.project_id].projected_end_week
