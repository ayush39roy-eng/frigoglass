"""P12-T03: Priority board (contract §2, ADR 0018) and VIP projects
(contract §6, ADR 0022), plus the `is_vip` / `tracking_status` row
extensions on `/dashboard/projects` and `/gantt`.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import (
    HardGateReason,
    HubName,
    LabRegion,
    ProjectAccessRole,
    ProjectPriority,
    ProjectStatus,
    RoleName,
    WorkflowStepStatus,
)
from models.project_access import ProjectAccessGrant
from tests.auth_helpers import clear_current_principal_override
from tests.factories import (
    make_engineer,
    make_hub,
    make_priority_score,
    make_schedule_run,
    make_user,
)
from tests.p12_helpers import (
    CW,
    act_as,
    add_checkin,
    add_outcome,
    client_for,
    link_engineer,
    plan_step,
    set_progress,
    stepped_project,
)


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture(autouse=True)
def _no_dispatch(monkeypatch):
    """ADR 0040: a pin change now queues a greedy recalc (the priority-move
    path); nothing reaches Celery or Redis here (`test_adr0040_vip_pin.py`
    covers the dispatch itself)."""

    import services.priority_move as priority_move
    from workers.schedule_tasks import run_greedy_schedule

    monkeypatch.setattr(
        run_greedy_schedule, "delay", lambda *a, **k: SimpleNamespace(id="celery-task-test")
    )
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)


async def _scored(db_session, hub, name, priority, score=None, *, gates=None, **kw):
    project = await stepped_project(db_session, hub, name=name, priority=priority, **kw)
    if score is not None or gates:
        await make_priority_score(
            db_session, project, dims=[3] * 13, hard_gates=gates or [],
            weighted_score=score, normalized_pct=60, suggested_band=ProjectPriority.P2,
        )
    return project


# --- Priority board -------------------------------------------------------------------


async def test_board_groups_sorts_and_flags(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True)
    alpha = await _scored(db_session, gr, "Alpha", ProjectPriority.P1, 900)
    await _scored(db_session, gr, "Aardvark", ProjectPriority.P1, 900)
    await _scored(
        db_session, gr, "Beta", ProjectPriority.P1, 1100,
        gates=[HardGateReason.REGULATORY_DEADLINE_6MO],
    )
    await _scored(db_session, gr, "Gamma", ProjectPriority.P1)
    delta = await _scored(db_session, gr, "Delta", ProjectPriority.P2, 700, is_vip=True)
    await _scored(db_session, gr, "Echo", ProjectPriority.Q, 500)
    await _scored(db_session, gr, "Draftish", None, status=ProjectStatus.DRAFT)
    await add_outcome(db_session, run, alpha, projected=44, within_year=True)
    await plan_step(db_session, run, alpha, "PDD-E", 40, 45)
    await add_outcome(db_session, run, delta, projected=None, within_year=False, left_out=True)

    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.get("/priority-board")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["run_id"] == str(run.id)
    assert [c["priority"] for c in body["columns"]] == ["P1", "P2", "P3", "P4", "Q"]
    names = {c["priority"]: [card["name"] for card in c["cards"]] for c in body["columns"]}
    assert names == {
        "P1": ["Beta", "Aardvark", "Alpha", "Gamma"],
        "P2": ["Delta"],
        "P3": [],
        "P4": [],
        "Q": ["Echo"],
    }
    assert all(c["count"] == len(c["cards"]) for c in body["columns"])
    cards = {card["name"]: card for c in body["columns"] for card in c["cards"]}
    assert cards["Beta"]["hard_gated"] is True and cards["Alpha"]["hard_gated"] is False
    assert cards["Beta"]["score"] == 1100.0 and cards["Gamma"]["score"] is None
    assert cards["Beta"]["band"] == "P2"
    assert (cards["Alpha"]["projected_end_week"], cards["Alpha"]["within_year"]) == (44, True)
    assert cards["Alpha"]["health"] == "on_track"
    assert cards["Delta"]["health"] == "left_out" and cards["Delta"]["is_vip"] is True
    assert cards["Gamma"]["health"] is None and cards["Gamma"]["within_year"] is None
    assert cards["Alpha"]["tracking_status"] == "idle"
    assert cards["Alpha"]["hub"] == "R&D-Greece"
    assert cards["Alpha"]["hub_id"] == str(gr.id)
    assert cards["Alpha"]["status"] == "In Development"


async def test_board_no_active_run(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    await _scored(db_session, gr, "Solo", ProjectPriority.P3, 600)
    await act_as(db_session, RoleName.EXECUTIVE_VIEWER)
    async with client_for(db_session) as client:
        r = await client.get("/priority-board")
    body = r.json()
    assert body["run_id"] is None
    card = body["columns"][2]["cards"][0]
    assert (card["health"], card["projected_end_week"]) == (None, None)


@pytest.mark.parametrize("role", [RoleName.ENGINEER, RoleName.AUDITOR])
async def test_board_forbidden_roles(db_session, role):
    await act_as(db_session, role)
    async with client_for(db_session) as client:
        r = await client.get("/priority-board")
    assert r.status_code == 403


async def test_board_hub_scope_and_filter_never_widen(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    await _scored(db_session, gr, "Greek", ProjectPriority.P1, 900)
    await _scored(db_session, india, "Indian", ProjectPriority.P1, 900)

    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[gr.id])
    async with client_for(db_session) as client:
        own = await client.get("/priority-board")
        widened = await client.get("/priority-board", params={"hub_id": str(india.id)})
    assert [c["name"] for c in own.json()["columns"][0]["cards"]] == ["Greek"]
    assert widened.status_code == 200
    assert all(c["count"] == 0 for c in widened.json()["columns"])

    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        filtered = await client.get("/priority-board", params={"hub_id": str(india.id)})
    assert [c["name"] for c in filtered.json()["columns"][0]["cards"]] == ["Indian"]


# --- VIP projects ---------------------------------------------------------------------


async def test_vip_ranking_pins_first_then_auto(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    await _scored(db_session, gr, "Pin-Low", ProjectPriority.P3, 400, is_vip=True)
    await _scored(db_session, gr, "Pin-High", ProjectPriority.P1, 300, is_vip=True)
    await _scored(db_session, gr, "A2", ProjectPriority.P1, 800)
    await _scored(db_session, gr, "A1", ProjectPriority.P1, 1000)
    await _scored(db_session, gr, "B1", ProjectPriority.P2)
    await _scored(db_session, gr, "Q1", ProjectPriority.Q, 1200)
    await _scored(db_session, gr, "D1", ProjectPriority.P4, 100)
    await _scored(db_session, gr, "Parked", ProjectPriority.P1, 1300, status=ProjectStatus.ON_HOLD)

    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.get("/vip-projects", params={"limit": 10})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["year"], body["week_range"], body["limit"], body["run_id"]) == (
        "plan", [1, 52], 10, None,
    )
    [hub] = body["hubs"]
    assert (hub["hub"], hub["pinned_count"], hub["over_limit"]) == ("R&D-Greece", 2, False)
    assert [(p["rank"], p["name"], p["selection"]) for p in hub["projects"]] == [
        (1, "Pin-High", "pinned"),
        (2, "Pin-Low", "pinned"),
        (3, "A1", "auto"),
        (4, "A2", "auto"),
        (5, "B1", "auto"),
        (6, "D1", "auto"),
        (7, "Q1", "auto"),
    ]


async def test_vip_auto_fill_stops_at_limit_and_over_limit_keeps_every_pin(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    for i in range(12):
        await _scored(db_session, gr, f"Auto {i:02d}", ProjectPriority.P2, 100 + i)
    for i in range(11):
        await _scored(db_session, india, f"Pinned {i:02d}", ProjectPriority.P2, 100 + i,
                      is_vip=True)
    await _scored(db_session, india, "Unpinned", ProjectPriority.P1, 2000)

    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.get("/vip-projects", params={"limit": 10})
        default = await client.get("/vip-projects")
    hubs = {h["hub"]: h for h in r.json()["hubs"]}
    assert list(hubs) == ["PD-India", "R&D-Greece"]  # name order
    greece = hubs["R&D-Greece"]
    assert len(greece["projects"]) == 10
    assert greece["projects"][0]["name"] == "Auto 11"  # highest score first
    india_row = hubs["PD-India"]
    assert (india_row["pinned_count"], india_row["over_limit"]) == (11, True)
    assert len(india_row["projects"]) == 11
    assert {p["selection"] for p in india_row["projects"]} == {"pinned"}
    assert default.json()["limit"] == 15
    assert len({h["hub"]: h for h in default.json()["hubs"]}["R&D-Greece"]["projects"]) == 12


@pytest.mark.parametrize("limit", [9, 16, 0])
async def test_vip_limit_bounds(db_session, limit):
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.get("/vip-projects", params={"limit": limit})
    assert r.status_code == 422


async def test_vip_bad_year(db_session):
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.get("/vip-projects", params={"year": "2027"})
    assert r.status_code == 422


async def test_vip_year_membership(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True)
    both = await _scored(db_session, gr, "Both years", ProjectPriority.P1, 900)
    await plan_step(db_session, run, both, "PDD-E", 40, 60)
    await add_outcome(db_session, run, both, projected=60, within_year=False)
    later = await _scored(db_session, gr, "Next only", ProjectPriority.P1, 800)
    await plan_step(db_session, run, later, "PDD-E", 55, 70)
    await plan_step(db_session, run, later, "PDD-F", 20, 30, skipped=True)
    await add_outcome(db_session, run, later, projected=70, within_year=False)
    await _scored(db_session, gr, "Pipeline", ProjectPriority.P2, 700)  # not in the run
    await _scored(db_session, gr, "Draft", ProjectPriority.P1, 999, status=ProjectStatus.DRAFT)

    await act_as(db_session, RoleName.EXECUTIVE_VIEWER)
    async with client_for(db_session) as client:
        plan = await client.get("/vip-projects", params={"year": "plan"})
        nxt = await client.get("/vip-projects", params={"year": "next"})
    assert [p["name"] for p in plan.json()["hubs"][0]["projects"]] == ["Both years", "Pipeline"]
    assert nxt.json()["week_range"] == [53, 78]
    assert nxt.json()["run_id"] == str(run.id)
    assert [p["name"] for p in nxt.json()["hubs"][0]["projects"]] == ["Both years", "Next only"]


async def test_vip_card_fields(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True)
    user = await make_user(db_session, RoleName.HUB_PLANNER)
    project = await _scored(db_session, gr, "Card", ProjectPriority.P1, 900)
    await set_progress(db_session, project, "PDD-A", WorkflowStepStatus.DONE, percent=100,
                       start=10, end=12)
    await set_progress(db_session, project, "PDD-B", WorkflowStepStatus.IN_PROGRESS, percent=50,
                       start=20)
    await plan_step(db_session, run, project, "PDD-B", 20, 34)
    await add_outcome(db_session, run, project, projected=44, expected=40, within_year=True)
    await add_checkin(db_session, project, "PDD-B", CW, user)

    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[gr.id])
    async with client_for(db_session) as client:
        r = await client.get("/vip-projects")
    card = r.json()["hubs"][0]["projects"][0]
    assert card["current_stage"] == {
        "step_id": "PDD-B", "step_name": "Feasibility Study (Conceptual Design)",
        "status": "In Progress",
    }
    # Duration-weighted (I12): (100×1 + 50×4) / 38 total weeks of PDD category A.
    assert card["progress_pct"] == round((100 * 1 + 50 * 4) / 38)
    assert (card["expected_end_week"], card["projected_end_week"], card["within_year"]) == (
        40, 44, True,
    )
    assert card["priority"] == "P1" and card["score"] == 900.0 and card["category"] == "A"
    assert card["tracking_status"] == "live"
    assert card["health"] in {"on_track", "at_risk"}


@pytest.mark.parametrize("role", [RoleName.ENGINEER, RoleName.AUDITOR])
async def test_vip_forbidden_roles(db_session, role):
    await act_as(db_session, role)
    async with client_for(db_session) as client:
        r = await client.get("/vip-projects")
    assert r.status_code == 403


async def test_vip_hub_filter_never_widens(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    await _scored(db_session, gr, "Greek", ProjectPriority.P1, 900)
    await _scored(db_session, india, "Indian", ProjectPriority.P1, 900)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[gr.id])
    async with client_for(db_session) as client:
        own = await client.get("/vip-projects")
        widened = await client.get("/vip-projects", params={"hub_id": str(india.id)})
    assert [h["hub"] for h in own.json()["hubs"]] == ["R&D-Greece"]
    assert widened.json()["hubs"] == []


# --- PUT /projects/{id}/vip -----------------------------------------------------------


async def _vip_audits(db_session, project) -> list[str]:
    rows = (
        await db_session.execute(
            select(AuditLogEntry.action)
            .where(
                AuditLogEntry.entity_id == str(project.id),
                AuditLogEntry.action.like("project.vip_%"),
            )
            .order_by(AuditLogEntry.occurred_at)
        )
    ).scalars().all()
    return list(rows)


async def test_pin_and_unpin_audited_once(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await _scored(db_session, gr, "Pin me", ProjectPriority.P2, 500)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[gr.id])
    async with client_for(db_session) as client:
        first = await client.put(f"/projects/{project.id}/vip", json={"is_vip": True})
        again = await client.put(f"/projects/{project.id}/vip", json={"is_vip": True})
        off = await client.put(f"/projects/{project.id}/vip", json={"is_vip": False})
    assert first.json() == {"project_id": str(project.id), "is_vip": True}
    assert again.status_code == 200 and again.json()["is_vip"] is True
    assert off.json()["is_vip"] is False
    assert sorted(await _vip_audits(db_session, project)) == [
        "project.vip_pin", "project.vip_unpin",
    ]
    await db_session.refresh(project)
    assert project.is_vip is False


@pytest.mark.parametrize("body", [{"is_vip": "yes"}, {"is_vip": 1}, {}, {"is_vip": True, "x": 1}])
async def test_pin_request_validation(db_session, body):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await _scored(db_session, gr, "Strict", ProjectPriority.P2, 500)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.put(f"/projects/{project.id}/vip", json=body)
    assert r.status_code == 422


async def test_pin_rbac_negatives(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    leader = await make_engineer(db_session, gr, name="Leader")
    project = await _scored(db_session, gr, "Guarded", ProjectPriority.P2, 500, leader=leader)
    url = f"/projects/{project.id}/vip"
    async with client_for(db_session) as client:
        await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[india.id])
        assert (await client.put(url, json={"is_vip": True})).status_code == 404
        await act_as(db_session, RoleName.EXECUTIVE_VIEWER)
        assert (await client.put(url, json={"is_vip": True})).status_code == 403
        user = await act_as(db_session, RoleName.ENGINEER)
        await link_engineer(db_session, leader, user)
        assert (await client.put(url, json={"is_vip": True})).status_code == 403
        await act_as(db_session, RoleName.AUDITOR)
        assert (await client.put(url, json={"is_vip": True})).status_code in (403, 404)
    assert await _vip_audits(db_session, project) == []


@pytest.mark.parametrize(
    ("grant", "expected"), [(ProjectAccessRole.EDITOR, 403), (ProjectAccessRole.ADMIN, 200)]
)
async def test_pin_with_project_grant(db_session, grant, expected):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await _scored(db_session, gr, "Granted", ProjectPriority.P2, 500)
    granter = await make_user(db_session, RoleName.ADMIN)
    user = await act_as(db_session, RoleName.ENGINEER)
    db_session.add(
        ProjectAccessGrant(
            project_id=project.id, user_id=user.id, project_role=grant,
            granted_by_user_id=granter.id,
        )
    )
    await db_session.flush()
    async with client_for(db_session) as client:
        r = await client.put(f"/projects/{project.id}/vip", json={"is_vip": True})
    assert r.status_code == expected


# --- Row extensions -------------------------------------------------------------------


async def test_dashboard_projects_rows_carry_vip_and_tracking(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True)
    pinned = await _scored(db_session, gr, "Pinned", ProjectPriority.P1, 900, is_vip=True)
    await plan_step(db_session, run, pinned, "PDD-E", 28, 34)
    await _scored(db_session, gr, "Plain", ProjectPriority.P2, 500)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.get("/dashboard/projects")
    rows = {row["project_name"]: row for row in r.json()["rows"]}
    assert (rows["Pinned"]["is_vip"], rows["Pinned"]["tracking_status"]) == (True, "overdue")
    assert (rows["Plain"]["is_vip"], rows["Plain"]["tracking_status"]) == (False, "idle")


async def test_gantt_project_rows_carry_vip_and_tracking(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True)
    user = await make_user(db_session, RoleName.HUB_PLANNER)
    pinned = await _scored(db_session, gr, "Pinned", ProjectPriority.P1, 900, is_vip=True)
    await plan_step(db_session, run, pinned, "PDD-E", 31, 34)
    await add_outcome(db_session, run, pinned)
    await add_checkin(db_session, pinned, "PDD-E", CW, user)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.get("/gantt")
    assert r.status_code == 200, r.text
    [row] = r.json()["rows"]
    assert (row["is_vip"], row["tracking_status"]) == (True, "live")
    count = (await db_session.execute(select(func.count()).select_from(AuditLogEntry))).scalar_one()
    assert count == 0  # reads never audit
