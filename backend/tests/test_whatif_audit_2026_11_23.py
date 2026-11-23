"""Fixes from the 2026-11-23 What-if planner domain audit (docs/MEMORY.md).

- B1 (P38-T05, I43): an inactive engineer is not in the scheduler input, so the
  live run and the What-if never give him new work; his supply counts only up
  to his deactivation week (`WhatIfBaseline.engineer_active_weeks`, R38-1). A
  schedulable project whose stored leader is inactive gets the existing
  `LEFT_OUT no_leader` rule; the run does not fail.
- M2 (I59, R53-2b): plan-import KPIs and `delivery_by_year` use the served
  (Dashboard) buckets, so an unedited Projects-list import equals the
  Dashboard, Commercialized-delivered-this-year included.
- M1 (I58): `ImportProjectOut` serves `left_out_reason` and its label.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from models.engineer import Engineer, EngineerInactivePeriod
from models.enums import (
    EngineerAllowedCategory,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    RoleName,
    SolverType,
)
from scheduling import run_greedy_sgs
from scheduling.plan_import import served_outcome_class
from scheduling.types import ProjectScheduleOutcome
from scheduling.whatif import AddProject, Scenario, WhatIfBaseline, apply_scenario
from services.plan_import_xlsx import inactive_name_key
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from services.whatif import served_outcome
from services.whatif_baseline import engineer_active_weeks
from tests._plan_week import TEST_WEEK
from tests.export_read import xlsx_table
from tests.factories import make_engineer, make_project
from tests.test_p18_whatif_api import act_as, client_for
from tests.test_p18_whatif_api import make_world as make_whatif_world
from tests.test_p32_whatif_import_api import XLSX, parse
from tests.test_p32_whatif_import_api import _cleanup as _cleanup  # noqa: F401 (autouse)
from tests.test_p32_whatif_import_api import make_world as make_import_world
from tests.test_p58_projects_list_round_trip import _export

DEACTIVATED_WEEK = 20
CATS = [EngineerAllowedCategory.A_PLUS, EngineerAllowedCategory.A, EngineerAllowedCategory.B,
        EngineerAllowedCategory.C]  # fmt: skip


async def _deactivate(
    db_session: AsyncSession, eng: Engineer, week: int = DEACTIVATED_WEEK
) -> None:
    """The state `POST /engineers/{id}/deactivate` leaves (P38-T04)."""

    eng.active = False
    eng.deactivated_at = datetime.now(UTC)
    eng.deactivated_week = week
    eng.deactivated_plan_year = 2026
    eng.deactivation_reason = "left_company"
    db_session.add(EngineerInactivePeriod(engineer_id=eng.id, from_plan_year=2026, from_week=week))
    await db_session.flush()


async def _world_with_inactive(db_session: AsyncSession) -> tuple[SimpleNamespace, Engineer]:
    w = await make_whatif_world(db_session)
    # Idle (leads nothing, load 0) and on the same hub: before the fix the
    # What-if picker chose him for every added R&D-Greece project.
    ashish = await make_engineer(db_session, w.gr, name="Ashish Inactive", allowed_categories=CATS)
    await _deactivate(db_session, ashish)
    return w, ashish


# --- B1 -----------------------------------------------------------------------------------


async def test_inactive_engineer_is_not_in_the_schedule_input(db_session: AsyncSession) -> None:
    w, ashish = await _world_with_inactive(db_session)
    si = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    ids = {e.engineer_id for e in si.engineers}
    assert str(ashish.id) not in ids
    assert {str(w.eng_gr.id), str(w.eng_in.id)} <= ids


async def test_whatif_gives_an_inactive_engineer_no_new_work(db_session: AsyncSession) -> None:
    _w, ashish = await _world_with_inactive(db_session)
    si = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    aw = await engineer_active_weeks(
        db_session, current_week=si.current_week, horizon_weeks=si.horizon_weeks
    )
    baseline = WhatIfBaseline(schedule=si, engineer_active_weeks=aw)
    applied = apply_scenario(
        baseline,
        Scenario(
            add_projects=(AddProject(hub="R&D-Greece", category="C", count=5, priority="P1"),)
        ),  # fmt: skip
    )
    new = set(applied.new_project_ids)
    assert len(new) == 5
    leaders = {p.leader_engineer_id for p in applied.schedule_input.projects if p.project_id in new}
    assert str(ashish.id) not in leaders
    out = run_greedy_sgs(applied.schedule_input)
    booked = {s.assigned_engineer_id for o in out.project_outcomes for s in o.steps}
    assert str(ashish.id) not in booked


async def test_engineer_active_weeks_covers_from_the_week_after_deactivation(
    db_session: AsyncSession,
) -> None:
    _w, ashish = await _world_with_inactive(db_session)
    si = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    aw = await engineer_active_weeks(
        db_session, current_week=si.current_week, horizon_weeks=si.horizon_weeks
    )
    assert [a.engineer_id for a in aw] == [str(ashish.id)]
    entry = aw[0]
    assert entry.hub == "R&D-Greece" and entry.fte == 1.0
    # Whole-week rule: the deactivation week counts as worked.
    assert entry.is_active_in(DEACTIVATED_WEEK)
    assert not entry.is_active_in(DEACTIVATED_WEEK + 1)
    assert entry.covered_weeks[-1] >= si.horizon_weeks
    assert entry.active_weeks(1, 52) == DEACTIVATED_WEEK


async def test_no_period_gives_no_active_weeks(db_session: AsyncSession) -> None:
    await make_whatif_world(db_session)
    si = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    assert (
        await engineer_active_weeks(
            db_session, current_week=si.current_week, horizon_weeks=si.horizon_weeks
        )
        == ()
    )


async def test_whatif_capacity_excludes_the_inactive_engineer(db_session: AsyncSession) -> None:
    """R&D-Greece and PD-India have the same calendar and one active 1.0 FTE
    designer each; R&D-Greece also has Ashish, inactive after W20. So the
    remaining capacity (W32..52) is equal, and the year capacity is
    (1 + 20/52) times PD-India's (R38-1)."""

    await _world_with_inactive(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        sim = await client.post("/whatif/simulate", json={"scenario": {}})
        est = await client.post("/whatif/estimate", json={"scenario": {}})
    assert sim.status_code == 200, sim.text
    assert est.status_code == 200, est.text
    rows = {r["key"]: r for r in sim.json()["utilization_before"] if r["scope"] == "hub"}
    gr, ind = rows["R&D-Greece"], rows["PD-India"]
    assert gr["capacity_remaining"] == pytest.approx(ind["capacity_remaining"], abs=0.01)
    assert gr["capacity_year"] == pytest.approx(
        ind["capacity_year"] * (1 + DEACTIVATED_WEEK / 52), abs=0.01
    )
    design = {d["hub"]: d for d in est.json()["design"]}
    # Year basis, R38-1: 1.0 + 1.0 x 20/52 (2.0 before the fix).
    assert design["R&D-Greece"]["fte_before"] == pytest.approx(1 + DEACTIVATED_WEEK / 52, abs=0.01)


async def test_live_run_with_an_inactive_leader_leaves_the_project_out_no_leader(
    db_session: AsyncSession,
) -> None:
    """I42 normally prevents it; if a schedulable project is still led by an
    inactive engineer, the run does not fail and the project is `LEFT_OUT`
    with `no_leader` (DOMAIN_RULES "Engineer deactivation"). A Commercialized
    project keeps its inactive leader and stays excluded."""

    w, ashish = await _world_with_inactive(db_session)
    orphan = await make_project(
        db_session, w.gr, leader=ashish, name="Orphan", category=ProjectCategory.C,
        priority=ProjectPriority.P1, status=ProjectStatus.IN_QUEUE,
    )  # fmt: skip
    shipped = await make_project(
        db_session, w.gr, leader=ashish, name="Shipped", category=ProjectCategory.C,
        priority=ProjectPriority.P2, status=ProjectStatus.COMMERCIALIZED,
    )  # fmt: skip
    await db_session.flush()
    si = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    out = run_greedy_sgs(si)
    by_id = {o.project_id: o for o in out.project_outcomes}
    o = by_id[str(orphan.id)]
    assert o.left_out and o.no_leader and o.steps == ()
    assert by_id[str(shipped.id)].excluded
    await persist_schedule_output(
        db_session, si, out, solver_type=SolverType.GREEDY, trigger_reason="test", activate=True
    )


def test_inactive_name_key_strips_the_export_suffix() -> None:
    assert inactive_name_key("Ashish Kumar (inactive)") == inactive_name_key("ashish  kumar")
    assert inactive_name_key("  ") == ""


# --- M2 / M1 ------------------------------------------------------------------------------


def _outcome(**kw: Any) -> ProjectScheduleOutcome:
    base: dict[str, Any] = dict(
        project_id="p", within_year=False, left_out=False, blocked=False, excluded=False,
        eng_conflict=False, overlap=False, cat_not_allowed=False, spillover=False,
        no_leader=False, no_chamber_step_id=None, start_week=None, end_week=None, steps=(),
    )  # fmt: skip
    base.update(kw)
    return ProjectScheduleOutcome(**base)


def test_served_outcome_class_matches_the_whatif_served_outcome() -> None:
    from scheduling.whatif import classify_outcome

    cases = [
        _outcome(excluded=True, within_year=True),  # Commercialized delivered in Y0
        _outcome(excluded=True),
        _outcome(left_out=True, blocked=True),
        _outcome(left_out=True),
        _outcome(within_year=True),
        _outcome(),
        _outcome(blocked=True, within_year=True),
    ]
    for o in cases:
        assert served_outcome_class(o) == served_outcome(
            classify_outcome(o), blocked=o.blocked, within_year=o.within_year
        )
    assert served_outcome_class(cases[0]) == "within_year"
    assert served_outcome_class(cases[2]) == "blocked"


async def test_unedited_projects_list_import_equals_the_dashboard(db_session: AsyncSession) -> None:
    world = await make_import_world(db_session)
    # Delivered this year (no actual end week counts in 2026, R53-2b).
    await make_project(
        db_session, world.gr, name="Shipped Cooler", category=ProjectCategory.C,
        priority=ProjectPriority.P2, status=ProjectStatus.COMMERCIALIZED,
    )  # fmt: skip
    # No leader: LEFT_OUT no_leader, served with its reason (M1).
    orphan = await make_project(
        db_session, world.gr, name="Orphan Cooler", category=ProjectCategory.C,
        priority=ProjectPriority.P1, status=ProjectStatus.IN_QUEUE,
    )  # fmt: skip
    await db_session.flush()
    si = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    await persist_schedule_output(
        db_session, si, run_greedy_sgs(si), solver_type=SolverType.GREEDY,
        trigger_reason="test", activate=True,
    )  # fmt: skip
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        dash = (await c.get("/dashboard/completing-within-year")).json()
        data = await _export(c)
        parsed = await parse(c, data, name="projects-list.xlsx", ctype=XLSX)
        assert parsed.status_code == 200, parsed.text
        sim = await c.post("/whatif/import/simulate", json={"rows": parsed.json()["rows"]})
    assert sim.status_code == 200, sim.text
    s = sim.json()
    k = s["kpis"]
    assert k["within_plan_year"] == dash["within_year_count"]
    assert k["spillover"] == dash["spillover_count"]
    assert k["left_out"] == dash["left_out_count"]
    assert k["blocked"] == dash["blocked_count"]
    assert k["excluded"] + k["data_error"] == dash["excluded_count"]
    # The delivered project is a hidden (not simulated) plan project, counted
    # within the year and under Other in the 2026 delivery row.
    assert all(p["name"] != "Shipped Cooler" for p in s["projects"])
    rows_import = {r["kind"] + str(r.get("year")): r for r in s["delivery_by_year"]["rows"]}
    rows_dash = {r["kind"] + str(r.get("year")): r for r in dash["delivery_by_year"]["rows"]}
    for key, r in rows_dash.items():
        assert rows_import[key]["total"] == r["total"], key
        assert rows_import[key]["other"] == r["other"], key
    # The "Other" column has a value, so the import table shows it.
    y0 = next(r for r in s["delivery_by_year"]["rows"] if r.get("year") == 2026)
    assert y0["other"] == 1
    # M1: the not-placed reason on the import row.
    o = next(p for p in s["projects"] if p["ref"] == str(orphan.id))
    assert o["left_out_reason"] == "no_leader"
    assert o["left_out_reason_label"] == "No leader assigned"
    placed = next(p for p in s["projects"] if p["name"] == "Alpha Cooler")
    assert placed["left_out_reason"] is None and placed["left_out_reason_label"] is None


# --- BUG-4 --------------------------------------------------------------------------------


async def test_whatif_export_labels_a_delivered_commercialized_project_within_year(
    db_session: AsyncSession,
) -> None:
    w = await make_whatif_world(db_session)
    await make_project(
        db_session, w.gr, name="Shipped Export", category=ProjectCategory.C,
        priority=ProjectPriority.P2, status=ProjectStatus.COMMERCIALIZED,
    )  # fmt: skip
    await db_session.flush()
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        resp = await c.post("/whatif/export.xlsx", json={"scenario": {}})
    assert resp.status_code == 200, resp.text
    _, data = xlsx_table(resp.content, "Gantt data")
    rows = [r for r in data if r.get("project_name") == "Shipped Export"]
    assert rows
    assert {r["outcome"] for r in rows} == {"within_year"}
