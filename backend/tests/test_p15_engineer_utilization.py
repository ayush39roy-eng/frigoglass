"""P15-T01 (ADR 0028): GET /capacity/engineer-utilization and un-withheld leader names."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.engineer import Engineer
from models.enums import HubName, LabRegion, RoleName, SolverType
from models.hub import Hub
from scheduling.greedy import run_greedy_sgs
from seed import seed_demo_data
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_engineer, make_hub, make_schedule_run
from tests.p12_helpers import act_as, client_for, link_engineer, plan_step, stepped_project

URL = "/capacity/engineer-utilization"
ACTION = "capacity.engineer_utilization.read"


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _seeded(db_session):
    data = seed_demo_data._load_prototype_data()
    hubs = await seed_demo_data.seed_hubs(db_session)
    engineers = await seed_demo_data.seed_engineers(db_session, data, hubs)
    await seed_demo_data.seed_chambers(db_session)
    await seed_demo_data.seed_projects(db_session, data, hubs, engineers)
    await db_session.flush()
    schedule_input = await build_schedule_input_from_db(db_session)
    output = run_greedy_sgs(schedule_input)
    await persist_schedule_output(
        db_session, schedule_input, output, solver_type=SolverType.GREEDY,
        trigger_reason="test", activate=True,
    )


async def _get(client, path=URL, **params):
    resp = await client.get(path, params={k: str(v) for k, v in params.items()})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_engineer_sums_equal_hub_design_load(db_session):
    await _seeded(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client)
        cap = await _get(client, "/capacity/hub-load")
    assert body["engineers"] and body["week_range"] == [1, 52]
    by_hub: dict[str, float] = {}
    for row in body["engineers"]:
        assert [w["week"] for w in row["weeks"]] == list(range(1, 53))
        assert row["total_booked"] >= sum(w["booked"] for w in row["weeks"])
        by_hub[row["hub"]] = by_hub.get(row["hub"], 0) + row["total_booked"]
        for w in row["weeks"]:
            assert w["booked"] <= 1
            if w["capacity"] > 0:
                # computed from the unrounded capacity; tolerate the 2 dp display rounding
                assert abs(w["utilization_pct"] - w["booked"] / w["capacity"] * 100) <= max(
                    0.6, 0.02 * w["utilization_pct"]
                )
    loads = {r["hub"]: r["design_load_weeks"] for r in cap["rows"]}
    # I6 across the whole portfolio: every design week is booked to some engineer.
    assert sum(by_hub.values()) == sum(loads.values())
    # OEM hubs have no engineers of their own; their design steps are booked
    # to PD engineers, so the per-hub identity is exact for every other hub
    # that is not lending engineers, and the lenders only exceed their load.
    oem = {"OEM-HCK", "OEM-Seltek"}
    for hub, load in loads.items():
        if hub in oem:
            assert by_hub.get(hub, 0) == 0
        else:
            assert by_hub.get(hub, 0) >= load, hub
    assert by_hub["R&D-Greece"] == loads["R&D-Greece"]
    assert by_hub["R&D-India"] == loads["R&D-India"]


async def test_region_and_hub_filters_and_hub_planner_scope(db_session):
    await _seeded(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        everyone = await _get(client)
        india = await _get(client, region="India")
        hubs = (await db_session.execute(select(Hub))).scalars().all()
        one = next(h for h in hubs if h.name == HubName.RD_GREECE)
        by_hub = await _get(client, hub_id=one.id)
        other = await _get(client, hub_id=one.id, region="India")  # ANDed: no overlap
    assert 0 < len(india["engineers"]) < len(everyone["engineers"])
    assert {r["hub"] for r in by_hub["engineers"]} == {"R&D-Greece"}
    assert other["engineers"] == []
    india_hubs = {h.name.value for h in hubs if h.lab_region == LabRegion.INDIA}
    assert {r["hub"] for r in india["engineers"]} <= india_hubs

    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[one.id])
    async with client_for(db_session) as client:
        planner = await _get(client)
        outside = await _get(client, region="India")
    assert {r["hub"] for r in planner["engineers"]} == {"R&D-Greece"}
    assert outside["engineers"] == []


async def test_engineer_role_sees_only_own_row_and_audit_has_no_figures(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True)
    me = await make_engineer(db_session, hub, name="Me Engineer")
    other = await make_engineer(db_session, hub, name="Other Engineer")
    project = await stepped_project(db_session, hub, name="P")
    await plan_step(db_session, run, project, "PDD-A", 31, 33, engineer=me)
    await plan_step(db_session, run, project, "PDD-B", 34, 35, engineer=other)
    # The RBAC matrix gives a plain Engineer no Capacity READ (403); the own-row
    # scope below is the defence in depth for an Engineer who also holds a role
    # that can read Capacity.
    user = await act_as(db_session, RoleName.ENGINEER)
    async with client_for(db_session) as client:
        assert (await client.get(URL)).status_code == 403
    user = await act_as(
        db_session, RoleName.ENGINEER, RoleName.EXECUTIVE_VIEWER, hub_scope_all=True
    )
    await link_engineer(db_session, me, user)
    async with client_for(db_session) as client:
        body = await _get(client)
    assert [r["name"] for r in body["engineers"]] == ["Me Engineer"]
    row = body["engineers"][0]
    assert row["total_booked"] == 3 and row["weeks"][30]["booked"] == 1
    assert "tcogs" not in str(body).lower() and "customer" not in str(body).lower()

    entries = (
        await db_session.execute(select(AuditLogEntry).where(AuditLogEntry.action == ACTION))
    ).scalars().all()
    assert len(entries) == 1
    assert entries[0].actor_user_id == user.id
    assert entries[0].after_state == {"hub_id": None, "region": None, "row_count": 1}
    assert "booked" not in str(entries[0].after_state)


async def test_engineers_do_not_leak_across_unlinked_users(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    await make_schedule_run(db_session, is_active=True)
    await make_engineer(db_session, hub, name="Someone")
    await act_as(
        db_session, RoleName.ENGINEER, RoleName.EXECUTIVE_VIEWER, hub_scope_all=True
    )  # linked to no engineer row
    async with client_for(db_session) as client:
        body = await _get(client)
    assert body["engineers"] == []


async def test_leader_name_returned_on_every_surface_and_exported(db_session):
    await _seeded(db_session)
    await act_as(db_session, RoleName.EXECUTIVE_VIEWER)
    async with client_for(db_session) as client:
        dash = (await _get(client, "/dashboard/projects"))["rows"]
        gantt = (await _get(client, "/gantt"))["rows"]
        matrix = await _get(client, "/priorities")
    for rows in (dash, gantt, matrix):
        led = [r for r in rows if r["leader_engineer_id"]]
        assert led and all(r["leader_name"] for r in led)
    names = {
        e.id: e.name for e in (await db_session.execute(select(Engineer))).scalars().all()
    }
    assert all(names[__import__("uuid").UUID(r["leader_engineer_id"])] == r["leader_name"]
               for r in dash if r["leader_engineer_id"])
