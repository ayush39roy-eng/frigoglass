"""P24-T01 (ADR 0035): the client's charter fields on projects.

`plant`, `requesting_department` and `product_type` are stored as the client
workbook writes them, served read-only on `ProjectRead` (and so on the
Workspace project) and on the Dashboard register row, and
`requesting_department` now drives the `GET /planning/resource-load` filter
and its `/options` list. Reuses the P19 hand-worked world: projects G1 and
R1 are category A, G2 is category B, O1 is A-OEM.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from api.db import get_db
from api.main import app
from models.enums import RoleName
from models.project import Project
from tests.auth_helpers import clear_current_principal_override
from tests.p12_helpers import act_as, client_for
from tests.test_p19_planning_capacity import LOAD, OPTIONS, _get, _world


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _label(db_session) -> dict[str, Project]:
    """G1 and R1 (both category A) are Marketing/Sales, G2 is PD, O1 has none."""

    projects = {p.name: p for p in (await db_session.execute(select(Project))).scalars()}
    for name, plant, department, product in (
        ("G1", "SAF", "Marketing/Sales", "ICM"),
        ("R1", "ROM", "Marketing/Sales", "ICM"),
        ("G2", "IND", "PD", "HA"),
        ("O1", "OEM-HCK", None, None),
    ):
        projects[name].plant = plant
        projects[name].requesting_department = department
        projects[name].product_type = product
    await db_session.flush()
    return projects


async def test_options_list_the_visible_departments(db_session):
    w = await _world(db_session)
    await _label(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client, OPTIONS)
        romania = await _get(client, OPTIONS, region="Romania")
        oem = await _get(client, OPTIONS, hub_id=str(w["oem"].id))
    assert body["requesting_departments"] == ["Marketing/Sales", "PD"]
    assert body["requesting_department_available"] is True
    assert romania["requesting_departments"] == ["Marketing/Sales"]
    # A hub whose projects carry no department: nothing to offer.
    assert oem["requesting_departments"] == []
    assert oem["requesting_department_available"] is False


async def test_options_respect_the_hub_scope(db_session):
    w = await _world(db_session)
    await _label(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w["romania"].id])
    async with client_for(db_session) as client:
        body = await _get(client, OPTIONS)
    assert body["requesting_departments"] == ["Marketing/Sales"]


async def test_resource_load_filters_by_department(db_session):
    """Marketing/Sales = G1 + R1 = exactly the category-A projects, so the two
    filters give the same load (the P19 hand-worked figures)."""

    await _world(db_session)
    await _label(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        by_dept = await _get(client, LOAD, requesting_department="Marketing/Sales")
        by_cat = await _get(client, LOAD, category="A")
        pd = await _get(client, LOAD, requesting_department="PD")
        both = await _get(client, LOAD, requesting_department=["PD", "Marketing/Sales"])
        unknown = await _get(client, LOAD, requesting_department="Development")
    eng = {r["name"]: r["load_weeks"] for r in by_dept["engineers"]}
    assert eng == {"Alpha": 3.0, "Beta": 0.0, "Gamma": 4.0}
    assert eng == {r["name"]: r["load_weeks"] for r in by_cat["engineers"]}
    assert by_dept["totals"] == by_cat["totals"]
    assert by_dept["filters_applied"]["requesting_department"] == ["Marketing/Sales"]
    # G2 only: Beta 2 + Alpha 5 (its skipped step adds nothing), GR-1 6.
    assert {r["name"]: r["load_weeks"] for r in pd["engineers"]}["Alpha"] == 5.0
    assert {r["code"]: r["load_weeks"] for r in pd["chambers"]}["GR-1"] == 6.0
    assert both["filters_applied"]["requesting_department"] == ["Marketing/Sales", "PD"]
    # O1 (no department) never matches; G1 + G2 + R1 = every labelled project.
    assert both["totals"]["engineers"]["load_weeks"] == 14.0
    assert unknown["totals"]["engineers"]["load_weeks"] == 0.0


async def test_project_read_and_register_serve_the_fields(db_session):
    await _world(db_session)
    projects = await _label(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        one = await _get(client, f"/projects/{projects['G2'].id}")
        none = await _get(client, f"/projects/{projects['O1'].id}")
        register = await _get(client, "/dashboard/projects")
    assert (one["plant"], one["requesting_department"], one["product_type"]) == (
        "IND",
        "PD",
        "HA",
    )
    assert (none["plant"], none["requesting_department"], none["product_type"]) == (
        "OEM-HCK",
        None,
        None,
    )
    rows = {r["project_name"]: r for r in register["rows"]}
    assert rows["G1"]["plant"] == "SAF"
    assert rows["G1"]["requesting_department"] == "Marketing/Sales"
    assert rows["R1"]["product_type"] == "ICM"
    assert rows["O1"]["requesting_department"] is None


async def test_charter_fields_are_read_only_on_the_api(db_session):
    """Imported data only for now (ADR 0035): the strict request models reject
    them, so nothing writes them without an audited, designed edit path."""

    w = await _world(db_session)
    projects = await _label(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        patch = await client.patch(f"/projects/{projects['G1'].id}", json={"plant": "IND"})
        create = await client.post(
            "/projects", json={"name": "X", "hub_id": str(w["greece"].id), "plant": "IND"}
        )
    assert patch.status_code == 422
    assert create.status_code == 422
